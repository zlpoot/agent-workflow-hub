import type { DashboardStore, DashboardReadView } from '../control-plane/store.js';
import { DashboardProjection } from './projection.js';
import type { Viewer } from './security.js';

type Snapshot = ReturnType<DashboardProjection['snapshot']>;
interface Entry { revision: string; view: DashboardReadView; bucket: number; snapshot?: Snapshot; fingerprint?: string; used: number }
// Cache is store-local and keyed by the exact sorted scope, never viewer ID alone.
// At most four cheap DB probes/second for all streams; idle views do not re-read SQLite.
export class DashboardStreamCache {
  readonly #entries = new Map<string, Entry>();
  #revision = ''; #probed = -Infinity;
  constructor(readonly store: DashboardStore, readonly clock = Date.now) {}
  read(viewer: Viewer, now = Date.now, fresh = false) {
    const time = this.clock();
    if (fresh || time < this.#probed || time - this.#probed >= 250) {
      this.#revision = this.store.dashboardRevision(); this.#probed = time;
    }
    const key = JSON.stringify([...viewer.project_ids].sort());
    let entry = this.#entries.get(key);
    if (!entry || entry.revision !== this.#revision) {
      entry = { revision: this.#revision, view: this.store.dashboardReadView(viewer), bucket: -Infinity, used: time };
      this.#entries.delete(key); this.#entries.set(key, entry);
      if (this.#entries.size > 64) this.#entries.delete(this.#entries.keys().next().value!);
    }
    entry.used = time;
    const projection = new DashboardProjection(this.store, viewer, now, () => entry.view);
    const bucket = Math.floor(now() / 1000);
    if (entry.bucket !== bucket || !entry.snapshot) {
      entry.snapshot = projection.snapshot(); entry.bucket = bucket;
      entry.fingerprint = JSON.stringify({ projects: entry.snapshot.projects, runs: entry.snapshot.runs,
        executors: entry.snapshot.executors.map(({ observed_at: _observed, ...executor }) => executor) });
    }
    // Release inactive scopes after a minute; count is independently bounded.
    for (const [scope, cached] of this.#entries) if (time - cached.used > 60000) this.#entries.delete(scope);
    return { projection, snapshot: entry.snapshot, fingerprint: entry.fingerprint! };
  }
}
const caches = new WeakMap<DashboardStore, DashboardStreamCache>();
export function streamCache(store: DashboardStore) {
  let cache = caches.get(store); if (!cache) { cache = new DashboardStreamCache(store); caches.set(store, cache); }
  return cache;
}
