import {
  LayoutDashboard,
  ListTodo,
  RefreshCw,
  ArrowUpRight,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./ui/button";
import { Status } from "./status";
import { stamp, taskSnapshotPending } from "../lib/task-model.mjs";
import type { DashboardState } from "../hooks/use-dashboard";
export type View = "Overview" | "Tasks";
export function AppShell({
  view,
  setView,
  state,
  fixture,
  refresh,
  children,
}: {
  view: View;
  setView: (v: View) => void;
  state: DashboardState;
  fixture: boolean;
  refresh: () => void;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">A</span>
          <div>
            <strong>AWH</strong>
            <span>工作流指挥台</span>
          </div>
          <span className="version">V2</span>
        </div>
        <p className="nav-label">WORKSPACE / 工作区</p>
        <nav aria-label="面板导航">
          {(["Overview", "Tasks"] as View[]).map((name) => (
            <Button
              key={name}
              variant="ghost"
              aria-current={view === name ? "page" : undefined}
              onClick={() => setView(name)}
            >
              {name === "Overview" ? (
                <LayoutDashboard aria-hidden="true" />
              ) : (
                <ListTodo aria-hidden="true" />
              )}
              {name === "Overview" ? "总览" : "任务"}
              <span className="nav-english">{name}</span>
            </Button>
          ))}
        </nav>
        <div className="sidebar-note">
          <ShieldCheck size={18} aria-hidden="true" />
          <strong>只读工作区</strong>
          <p>观察任务，保留事实来源。独立 Review 由下一责任方完成。</p>
          <span>SHADCN/UI · TAILWIND 4</span>
        </div>
      </aside>
      <main id="main-content" tabIndex={-1}>
        <header className="topbar">
          <span>
            工作区 <span className="muted">/</span>{" "}
            {view === "Overview" ? "总览" : "任务"}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Status value={state.phase} />
            <Button
              variant="outline"
              onClick={refresh}
              disabled={["loading", "refreshing"].includes(state.phase)}
            >
              <RefreshCw aria-hidden="true" />
              刷新
            </Button>
            <Button variant="ghost" asChild>
              <a href="/dashboard">
                Dashboard V1 <ArrowUpRight aria-hidden="true" />
              </a>
            </Button>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">WORKFLOW COMMAND CENTER</p>
              <h1>{view === "Overview" ? "工作流总览" : "任务工作台"}</h1>
              <p className="muted">
                {view === "Overview"
                  ? "让每一次交接，都有清晰的下一步。"
                  : "查看阶段、实际执行者、等待责任方与下一动作。"}
              </p>
            </div>
            {fixture && (
              <div className="fixture-note" role="note">
                示例预览 · 模拟数据
              </div>
            )}
          </div>
          <div className="freshness" aria-live="polite">
            <span>
              最近成功刷新：{stamp(state.lastRefresh)} · 快照游标{" "}
              {state.snapshot?.cursor ?? "—"}
            </span>
            <span>注册信息与事件存储 · GitHub 授权未核验</span>
          </div>
          {state.snapshot &&
            taskSnapshotPending(
              state.phase,
              state.snapshot.cursor,
              state.events,
            ) && (
              <div className="notice" role="status">
                有新事件待同步；当前显示历史快照。任务阶段、执行者、责任方和下一动作已降级，等待快照同步完成。
              </div>
            )}
          {state.error && (
            <div className="notice" role="alert">
              读取或实时连接暂不可用。
              {state.snapshot
                ? "显示上次成功读取的快照；当前任务状态与执行者已降级为未知。"
                : "暂无可用快照；需要受保护的同源 Viewer 会话。"}
            </div>
          )}
          {children}
          <footer>
            只读预览 · 注册 / 心跳不代表 GitHub 授权 · 运行时声明不代表独立
            Review
          </footer>
        </div>
      </main>
    </div>
  );
}
