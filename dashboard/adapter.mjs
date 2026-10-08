import validators from '../dist/dashboard-ui/validators.cjs';

export function assertContract(name, value) {
  if (!validators[name]?.(value)) throw new Error('Dashboard contract mismatch');
  return value;
}
export function safeGitHubUrl(ref) {
  if (!ref || ref.authority_verified !== false || ref.provider !== 'github' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ref.repository) || !Number.isSafeInteger(ref.number) || ref.number < 1) return null;
  const kind = ref.kind === 'issue' ? 'issues' : ref.kind === 'pull_request' ? 'pull' : null;
  return kind ? `https://github.com/${ref.repository}/${kind}/${ref.number}` : null;
}
export function safeSourceUrl(source) {
  return source && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository) && /^[a-f0-9]{40}$/.test(source.sha)
    ? `https://github.com/${source.repository}/commit/${source.sha}` : null;
}
export function mergeEvents(previous, incoming) {
  const map = new Map(previous.map(event => [event.cursor, event]));
  for (const event of incoming) {
    assertContract('TimelineEvent', event);
    const old = map.get(event.cursor);
    if (old && JSON.stringify(old) !== JSON.stringify(event)) throw new Error('Conflicting persistent cursor');
    map.set(event.cursor, event);
  }
  return [...map.values()].sort((a, b) => a.cursor - b.cursor);
}

// Same-origin, fixed, read-only endpoints. No bearer, URL/config passthrough or storage.
export class DashboardReader {
  constructor({ fetcher = (...args) => globalThis.fetch(...args), openStream = path => new EventSource(path), now = Date.now,
    publish, schedule = (fn, ms) => globalThis.setTimeout(fn, ms), cancel = timer => globalThis.clearTimeout(timer) }) {
    Object.assign(this, { fetcher, openStream, now, publish, schedule, cancel });
    this.state = { snapshot: null, events: [], phase: 'loading', lastRefresh: null, error: null };
    this.closed = false; this.generation = 0; this.timer = null; this.stream = null; this.retry = 1000;
  }
  emit(patch) { this.state = { ...this.state, ...patch }; this.publish(this.state); }
  async get(path, schema, signal) {
    const response = await this.fetcher('/dashboard/v1' + path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
    if (!response.ok) {
      const error = new Error(response.status === 401 || response.status === 403 ? 'Viewer session unavailable or expired' :
        response.status === 404 ? 'Read gateway is not enabled' : response.status === 503 ? 'Read projection temporarily unavailable' : 'Dashboard request failed');
      error.status = response.status; throw error;
    }
    try { return assertContract(schema, await response.json()); }
    catch { throw new Error('Dashboard contract mismatch'); }
  }
  queue(ms = 150) {
    if (this.closed || this.timer !== null) return;
    this.timer = this.schedule(() => { this.timer = null; void this.refresh(); }, ms);
  }
  async refresh() {
    if (this.closed) return;
    const generation = ++this.generation;
    this.controller?.abort();
    if (this.timer !== null) { this.cancel(this.timer); this.timer = null; }
    const controller = this.controller = new AbortController();
    this.emit({ phase: this.state.snapshot ? 'refreshing' : 'loading', error: null });
    try {
      const snapshot = await this.get('/snapshot', 'Snapshot', controller.signal);
      let events = [];
      // Snapshot watermark is captured before pagination. Later Events replay from this watermark.
      for (const run of snapshot.runs) {
        let after = 0;
        for (;;) {
          const page = await this.get(`/runs/${encodeURIComponent(run.id)}/timeline?after=${after}&limit=100`, 'TimelinePage', controller.signal);
          if (page.items.some(event => event.run_id !== run.id || event.cursor <= after) || page.snapshot_cursor < snapshot.cursor)
            throw new Error('Invalid timeline scope or watermark');
          events = mergeEvents(events, page.items.filter(event => event.cursor <= snapshot.cursor));
          if (events.length > 10000) throw new Error('Dashboard history limit reached');
          if (page.next_cursor === null || page.next_cursor >= snapshot.cursor) break;
          if (page.next_cursor <= after || page.next_cursor !== page.items.at(-1)?.cursor) throw new Error('Timeline pagination did not advance');
          after = page.next_cursor;
        }
      }
      if (this.closed || generation !== this.generation) return;
      events = mergeEvents(events, this.state.events.filter(event => event.cursor > snapshot.cursor));
      this.emit({ snapshot, events, phase: events.some(event => event.cursor > snapshot.cursor) ? 'partial' : this.stream?.readyState === 1 ? 'live' : 'connecting', lastRefresh: this.now(), error: null }); this.retry = 1000;
      if (this.stream) return;
      const stream = this.stream = this.openStream('/dashboard/v1/events/stream?after=' + snapshot.cursor);
      stream.addEventListener('open', () => { if (stream === this.stream && !this.closed) this.emit({ phase: this.state.events.some(event => event.cursor > this.state.snapshot.cursor) ? 'partial' : 'live' }); });
      stream.addEventListener('timeline-event', frame => {
        if (stream !== this.stream || this.closed) return;
        try {
          const event = assertContract('TimelineEvent', JSON.parse(frame.data));
          if (String(event.cursor) !== frame.lastEventId || !this.state.snapshot.projects.some(project => project.id === event.project_id))
            throw new Error('Invalid stream binding');
          if (event.cursor <= this.state.snapshot.cursor) return;
          this.emit({ events: mergeEvents(this.state.events, [event]), phase: 'partial' }); this.queue();
        } catch { this.disconnect('Invalid stream contract'); }
      });
      stream.addEventListener('view-refresh', frame => {
        if (stream !== this.stream || this.closed) return;
        try { assertContract('ViewRefresh', JSON.parse(frame.data)); this.queue(); }
        catch { this.disconnect('Invalid refresh contract'); }
      });
      stream.onerror = () => { if (stream === this.stream && !this.closed) this.disconnect('Live connection interrupted'); };
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      this.stream?.close(); this.stream = null;
      this.emit({ phase: this.state.snapshot ? 'outdated' : 'error', error: error.status ? error.message : 'Read projection or connection unavailable' });
      if (![401, 403, 404].includes(error.status)) { this.queue(this.retry); this.retry = Math.min(15000, this.retry * 2); }
    }
  }
  disconnect(message) {
    this.stream?.close(); this.stream = null;
    this.emit({ phase: 'offline', error: message }); this.queue(this.retry); this.retry = Math.min(15000, this.retry * 2);
  }
  stop() { this.closed = true; ++this.generation; this.controller?.abort(); this.stream?.close(); if (this.timer !== null) this.cancel(this.timer); }
}
