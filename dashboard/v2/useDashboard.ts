import { useCallback, useEffect, useRef, useState } from 'react';
import { DashboardReader } from '../adapter.mjs';
import type { Task } from '../../src/dashboard/tasks.js';
import type { DashboardPhase } from './semantics.js';
import { presentationState } from './presentation.js';

// The V2 PoC reuses the existing DashboardReader verbatim: same same-origin read-only
// endpoints, same contract validators, same SSE semantics and the same phase machine.
export interface Snapshot {
  cursor: number;
  projects: {
    id: string; name: string | null; repository: string; profile_ref: string; enabled: boolean | null;
    last_activity: string | null; active_runs: { id: string }[]; metadata_provenance: string;
  }[];
  runs: {
    id: string; project_id: string; state: string; executor_id: string; machine_id: string;
    updated_at: string; source: { sha: string; ref: string; repository: string };
  }[];
  executors: {
    id: string; display_name: string; platform: string; status: string; last_seen: string;
    machine: { id: string; name: string | null }; current_runs: { id: string }[]; presence_provenance: string;
  }[];
  tasks?: Task[];
}
export interface TimelineEvent {
  cursor: number; run_id: string; project_id: string; type: string; result: string; timestamp: string;
}
export interface DashboardState {
  factsUnavailable?: boolean;
  snapshot: Snapshot | null;
  events: TimelineEvent[];
  phase: DashboardPhase;
  lastRefresh: number | null;
  error: string | null;
}
export interface TaskDetail {
  item: Task | null;
  loading: boolean;
  error: string | null;
}

const initial: DashboardState = { snapshot: null, events: [], phase: 'loading', lastRefresh: null, error: null };

export function useDashboard() {
  const [state, setState] = useState<DashboardState>(initial);
  const [, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const reader = useRef<DashboardReader | null>(null);
  useEffect(() => {
    const client = reader.current = new DashboardReader({ publish: (incoming: DashboardState) =>
      setState(previous => presentationState(previous, incoming)), githubInterval: 300 });
    void client.refresh();
    return () => client.stop();
  }, []);
  // Local observations are not CP Events; poll reads independently from SSE invalidations.
  useEffect(() => {
    const timer = setInterval(() => {
      const client = reader.current;
      if (client && client.state.phase !== 'loading' && client.state.phase !== 'refreshing') void client.refresh();
    }, 10000);
    return () => clearInterval(timer);
  }, []);
  const refresh = useCallback(() => { void reader.current?.refresh(); }, []);

  const [detail, setDetail] = useState<TaskDetail>({ item: null, loading: false, error: null });
  const detailAbort = useRef<AbortController | null>(null);
  const openTask = useCallback((task: Task) => {
    detailAbort.current?.abort();
    const abort = detailAbort.current = new AbortController();
    setDetail({ item: task, loading: true, error: null });
    reader.current?.get('/tasks/' + encodeURIComponent(task.id), 'TaskResponse', abort.signal)
      .then((response: { item: Task }) => { if (!abort.signal.aborted) setDetail({ item: response.item, loading: false, error: null }); })
      .catch(() => { if (!abort.signal.aborted) setDetail({ item: task, loading: false, error: '任务详情暂不可用；显示快照中的字段' }); });
  }, []);
  const closeTask = useCallback(() => {
    detailAbort.current?.abort(); detailAbort.current = null;
    setDetail({ item: null, loading: false, error: null });
  }, []);

  return { state, now: Date.now(), refresh, detail, openTask, closeTask };
}

export const isFixtureDataset = () =>
  document.querySelector<HTMLMetaElement>('meta[name="awh-dataset"]')?.content === 'fixture';
