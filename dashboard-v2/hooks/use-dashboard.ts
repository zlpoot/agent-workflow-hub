import { useEffect, useRef, useState } from "react";
import { DashboardReader } from "../../dashboard/adapter.mjs";
import type { Task } from "../../src/dashboard/tasks.js";
export type Snapshot = {
  cursor: number;
  tasks: Task[];
  projects: { id: string; name: string | null; repository: string }[];
  executors: {
    id: string;
    display_name: string;
    last_seen: string;
    status: "online" | "offline" | "unknown";
  }[];
};
export type DashboardState = {
  snapshot: Snapshot | null;
  events: { cursor: number }[];
  phase: string;
  lastRefresh: number | null;
  error: string | null;
};
export function useDashboard() {
  const [state, setState] = useState<DashboardState>({
    snapshot: null,
    events: [],
    phase: "loading",
    lastRefresh: null,
    error: null,
  });
  const [, setNow] = useState(Date.now());
  const reader = useRef<DashboardReader | null>(null);
  useEffect(() => {
    const client = (reader.current = new DashboardReader({
      publish: (next: DashboardState) => {
        setState(next);
        setNow(Date.now());
      },
      githubInterval: 300,
    }));
    void client.refresh();
    const poll = setInterval(() => {
      if (!["loading", "refreshing"].includes(client.state.phase))
        void client.refresh();
    }, 10000);
    const clock = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
      client.stop();
    };
  }, []);
  return {
    state,
    now: Date.now(),
    reader,
    refresh: () => void reader.current?.refresh(),
  };
}
export function useTaskDetail(
  id: string | null,
  fallback: Task | null,
  lastRefresh: number | null,
  reader: ReturnType<typeof useDashboard>["reader"],
) {
  const [detail, setDetail] = useState<{
    id: string | null;
    task: Task | null;
    loading: boolean;
    error: string | null;
  }>({ id: null, task: null, loading: false, error: null });
  useEffect(() => {
    if (!id) {
      setDetail({ id: null, task: null, loading: false, error: null });
      return;
    }
    const abort = new AbortController();
    setDetail((old) => ({
      id,
      task: old.id === id ? old.task : null,
      loading: true,
      error: null,
    }));
    reader.current
      ?.get("/tasks/" + encodeURIComponent(id), "TaskResponse", abort.signal)
      .then((value: { item: Task }) => {
        if (!abort.signal.aborted)
          setDetail({ id, task: value.item, loading: false, error: null });
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setDetail((old) => ({
            ...old,
            loading: false,
            error: "任务详情读取失败；仅展示历史快照，当前状态未知。",
          }));
      });
    return () => abort.abort();
  }, [id, lastRefresh, reader]);
  return {
    task: detail.id === id ? (detail.task ?? fallback) : fallback,
    loading: detail.id !== id || detail.loading,
    error: detail.id === id ? detail.error : null,
  };
}
