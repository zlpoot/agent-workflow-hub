import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppShell, type View } from "./components/app-shell";
import { Card } from "./components/ui/card";
import { TaskDetail } from "./components/task-detail";
import { Overview } from "./pages/overview";
import { Tasks } from "./pages/tasks";
import { useDashboard, useTaskDetail } from "./hooks/use-dashboard";
import { GitHubObservation } from "./components/github-observation";
import { taskSnapshotUnreliable } from "./lib/task-model.mjs";
function App() {
  const [view, setView] = useState<View>("Overview"),
    [taskId, setTaskId] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const { state, now, reader, refresh } = useDashboard();
  const tasks = state.snapshot?.tasks ?? [],
    disconnected = taskSnapshotUnreliable(
      state.phase,
      state.snapshot?.cursor,
      state.events,
    );
  const detail = useTaskDetail(
    taskId,
    tasks.find((t) => t.id === taskId) ?? null,
    state.lastRefresh,
    reader,
  );
  const props = {
    tasks,
    open: (id: string) => {
      opener.current = document.activeElement as HTMLElement;
      setTaskId(id);
    },
    disconnected,
    now,
  };
  const fixture =
    document.querySelector<HTMLMetaElement>('meta[name="awh-dataset"]')
      ?.content === "fixture";
  return (
    <>
      <AppShell
        view={view}
        setView={setView}
        state={state}
        fixture={fixture}
        refresh={refresh}
      >
        <GitHubObservation tasks={tasks} reader={reader} now={now} />
        {!state.snapshot ? (
          <Card className="empty">
            <h2>
              {state.phase === "loading" ? "正在加载活动记录…" : "面板暂不可用"}
            </h2>
            <p>正在读取现有 Dashboard 的只读契约。</p>
          </Card>
        ) : view === "Overview" ? (
          <Overview
            {...props}
            snapshot={state.snapshot}
            showTasks={() => setView("Tasks")}
          />
        ) : (
          <Tasks {...props} />
        )}
      </AppShell>
      <TaskDetail
        {...detail}
        selected={taskId !== null}
        close={() => setTaskId(null)}
        restoreFocus={() => opener.current?.focus()}
        disconnected={disconnected}
        now={now}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
