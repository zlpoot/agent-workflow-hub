import type { Task } from "../../src/dashboard/tasks.js";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "./ui/sheet";
import { Card } from "./ui/card";
import { Status } from "./status";
import { GitHubLink } from "./task-list";
import { sourceLabels, stamp, taskFacts } from "../lib/task-model.mjs";
import { localStale } from "../../dashboard/task-freshness.mjs";
import { safeSourceUrl } from "../../dashboard/adapter.mjs";
import type { ReactNode } from "react";
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="detail-fact">
      <dt>{label}</dt>
      <dd>{children ?? "未提供"}</dd>
    </div>
  );
}
export function TaskDetail({
  task,
  selected,
  close,
  restoreFocus,
  disconnected,
  now,
  loading,
  error,
}: {
  task: Task | null;
  selected: boolean;
  close: () => void;
  restoreFocus: () => void;
  disconnected: boolean;
  now: number;
  loading: boolean;
  error: string | null;
}) {
  const facts = task ? taskFacts(task, disconnected || !!error, now) : null;
  const actorUnknown =
    disconnected || !!error || (!!task && localStale(task, now));
  const source =
    task &&
    safeSourceUrl({ repository: task.repository, sha: task.source_head });
  return (
    <Sheet
      open={selected}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent
        className="task-sheet"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <SheetHeader>
          <SheetTitle>
            任务详情 · #{task?.issue.number} {task?.issue.title ?? ""}
          </SheetTitle>
          <SheetDescription>
            来源分开保留；运行时声明不授予 Review、GitHub 授权或合并权限。
          </SheetDescription>
        </SheetHeader>
        <div className="sheet-body">
          {loading && <p role="status">正在重新核验任务…</p>}
          {error && (
            <div role="alert" className="notice">
              {error}
            </div>
          )}
          {task && facts && (
            <>
              {task.fixture && (
                <div className="fixture-note">示例预览 · 模拟数据</div>
              )}
              <Card className="detail-card">
                <Status value={facts.state} />
                <h3>{task.repository}</h3>
                <div className="flex gap-4">
                  <GitHubLink
                    task={task}
                    kind="issue"
                    number={task.issue.number}
                  >
                    Issue #{task.issue.number}
                  </GitHubLink>
                  {task.pr && (
                    <GitHubLink
                      task={task}
                      kind="pull_request"
                      number={task.pr.number}
                    >
                      PR #{task.pr.number}
                    </GitHubLink>
                  )}
                </div>
                <dl>
                  <Fact label="Project / Workflow">
                    {task.project_id} · {task.workflow}
                  </Fact>
                  <Fact label="当前实际执行者">{facts.actor}</Fact>
                  <Fact label="等待责任方">{facts.waiting}</Fact>
                  <Fact label="下一动作">{facts.action}</Fact>
                </dl>
                {task.blockers.map((value, i) => (
                  <p key={i} className="notice">
                    {value}
                  </p>
                ))}
              </Card>
              <Card className="detail-card">
                <h3>Executor / Machine</h3>
                <dl>
                  <Fact label="执行者">{task.executor}</Fact>
                  <Fact label="机器">
                    {task.machine?.name} · {task.machine?.platform ?? "未知"}
                  </Fact>
                  <Fact label="Machine ID">{task.machine?.id}</Fact>
                  <Fact label="Watcher">
                    {actorUnknown ? "当前未知" : task.watcher.status} ·{" "}
                    {actorUnknown || task.watcher.running === null
                      ? "未核验"
                      : task.watcher.running
                        ? "正在运行"
                        : "已停止"}
                  </Fact>
                  <Fact label="Executor 进程">
                    {actorUnknown || task.watcher.executor_running === null
                      ? "未核验"
                      : task.watcher.executor_running
                        ? "正在执行"
                        : "未运行"}
                  </Fact>
                </dl>
              </Card>
              <Card className="detail-card">
                <h3>证据与 HEAD</h3>
                <dl>
                  <Fact label="本机 HEAD">
                    {source ? (
                      <a
                        href={source}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {task.source_head}
                      </a>
                    ) : (
                      task.source_head
                    )}
                  </Fact>
                  <Fact label="GitHub HEAD（历史观察）">
                    {task.github_head}
                  </Fact>
                  <Fact label="独立 Review Gate（历史观察）">
                    {task.review_gate.status} · {task.review_gate.reason}
                  </Fact>
                  <Fact label="原生 Review（历史观察）">
                    {task.review
                      ? `${task.review.state} · ${task.review.decision ?? '未提供决定'} · ${task.review.actor} · ${task.review.commit_id}`
                      : "未核验"}
                  </Fact>
                  <Fact label="PR / Merge（历史观察）">{task.pr ? `${task.pr.state ?? '未知'} · ${stamp(task.pr.merged_at)} · ${task.pr.merge_sha ?? 'Merge HEAD 未提供'}` : '未提供'}</Fact>
                  <Fact label="Stage 验证（历史记录）">
                    {task.stage.status} · {task.stage.head ?? "HEAD 未提供"}
                  </Fact>
                  {task.stage.checks.map(check=><Fact key={check.name} label="定向校验">{check.name} · exit {check.exit_code}</Fact>)}
                  <Fact label="GitHub Checks（历史观察）">
                    {task.checks.status} · {task.checks.count}
                  </Fact>
                  <Fact label="Owner scope（历史摘要）">
                    {task.owner_scope.status} ·{" "}
                    {stamp(task.owner_scope.expires_at)}
                  </Fact>
                </dl>
                <p className="muted">
                  这些记录仅供只读查看；独立 Review 和授权由对应责任方完成。
                </p>
              </Card>
              <Card className="detail-card">
                <h3>数据来源与时效</h3>
                {task.observations.map((item, i) => (
                  <div className="observation" key={i}>
                    <strong>
                      {(sourceLabels as Record<string, string>)[item.source] ??
                        item.source}
                    </strong>
                    <p>
                      {item.status} · {item.freshness} ·{" "}
                      {stamp(item.observed_at)}
                    </p>
                    {item.error_code && <p>{item.error_code}</p>}
                  </div>
                ))}
                <p className="muted">注册 / 心跳不等于 GitHub 授权核验。</p>
              </Card>
              {task.workflow==='local-fast'&&task.pr&&facts.state==='awaiting_review'&&<Card className="detail-card"><h3>ChatGPT 独立 Review</h3><p>打开 PR，复制下列指令交给 Reviewer；新的 HEAD 必须重新审查。</p><textarea aria-label="ChatGPT Review 指令" readOnly rows={6} value={`请独立审查 https://github.com/${task.repository}/pull/${task.pr.number} 的实际当前完整 HEAD、完整差异及 Issue。运行必要定向测试；通过已有原生 Review Bridge 发布 COMMENTED + AWH-LOCAL-FAST-REVIEW v1 的 PASS 或 REQUEST_CHANGES，native commit_id 与 decision head 必须等于实际当前 HEAD。不要执行 Merge 或关闭 Issue。观察的历史 HEAD：${task.github_head??task.source_head??'未核验'}；请重新读取 GitHub。`} onFocus={e=>e.currentTarget.select()}/></Card>}
              <Card className="detail-card">
                <h3>历史记录</h3>
                {task.history.length ? (
                  task.history.map((item, i) => (
                    <div key={i} className="observation">
                      <strong>{item.type}</strong>
                      <p>
                        {item.source} ·{" "}
                        {stamp(item.occurred_at ?? item.observed_at)}
                      </p>
                      <code>{item.head ?? "HEAD 未提供"}</code>
                    </div>
                  ))
                ) : (
                  <p className="muted">未提供历史记录。</p>
                )}
              </Card>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
