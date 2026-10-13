import type { Task } from "../../src/dashboard/tasks.js";
import { ArrowUpRight, ChevronRight, Monitor } from "lucide-react";
import { safeGitHubUrl } from "../../dashboard/adapter.mjs";
import { taskFacts } from "../lib/task-model.mjs";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { Status } from "./status";
import type { ReactNode } from "react";
export function GitHubLink({
  task,
  kind,
  number,
  children,
}: {
  task: Task;
  kind: "issue" | "pull_request";
  number: number;
  children: ReactNode;
}) {
  const href = safeGitHubUrl({
    provider: "github",
    authority_verified: false,
    repository: task.repository,
    kind,
    number,
  });
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      className="external"
    >
      {children}
      <ArrowUpRight size={13} aria-hidden="true" />
    </a>
  ) : (
    <span>{children}</span>
  );
}
export type TaskListProps = {
  tasks: Task[];
  open: (id: string) => void;
  disconnected: boolean;
  now: number;
};
export function TaskList({ tasks, open, disconnected, now }: TaskListProps) {
  if (!tasks.length)
    return (
      <Card className="empty">
        <h3>没有匹配的任务</h3>
        <p>清除筛选，或等待当前只读范围内出现工作项。</p>
      </Card>
    );
  const title = (task: Task) => (
    <Button variant="link" className="task-title" onClick={() => open(task.id)}>
      #{task.issue.number || "未知"} {task.issue.title ?? "标题未核验"}
      <ChevronRight size={14} aria-hidden="true" />
    </Button>
  );
  return (
    <>
      <div className="desktop-table">
        <Table>
          <TableHeader>
            <TableRow>
              {[
                "任务 / 项目",
                "阶段",
                "执行者 / 机器",
                "等待责任方 / 下一动作",
                "GitHub",
              ].map((label) => (
                <TableHead key={label}>{label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map((task) => {
              const facts = taskFacts(task, disconnected, now);
              return (
                <TableRow key={task.id}>
                  <TableCell>
                    {title(task)}
                    <div className="muted">
                      {task.project_id} · {task.workflow}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Status value={facts.state} />
                  </TableCell>
                  <TableCell>
                    <div>{facts.actor}</div>
                    <div className="muted">
                      {task.executor ?? "执行者未提供"}
                    </div>
                    <div className="muted">
                      {task.machine?.name ?? "机器未提供"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div>{facts.waiting}</div>
                    <div className="muted action-text">{facts.action}</div>
                  </TableCell>
                  <TableCell>
                    <GitHubLink
                      task={task}
                      kind="issue"
                      number={task.issue.number}
                    >
                      Issue
                    </GitHubLink>
                    {task.pr && (
                      <div>
                        <GitHubLink
                          task={task}
                          kind="pull_request"
                          number={task.pr.number}
                        >
                          PR #{task.pr.number}
                        </GitHubLink>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div className="mobile-tasks">
        {tasks.map((task) => {
          const facts = taskFacts(task, disconnected, now);
          return (
            <Card key={task.id} className="mobile-task">
              <div className="row-between">
                <span className="muted">{task.project_id}</span>
                <Status value={facts.state} />
              </div>
              {title(task)}
              <div className="muted flex gap-2">
                <Monitor size={14} aria-hidden="true" />
                {task.executor ?? "未提供"} ·{" "}
                {task.machine?.name ?? "机器未提供"}
              </div>
              <p>当前执行：{facts.actor}</p>
              <p>等待：{facts.waiting}</p>
              <p className="muted">{facts.action}</p>
              <div className="flex gap-4">
                <GitHubLink task={task} kind="issue" number={task.issue.number}>
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
            </Card>
          );
        })}
      </div>
    </>
  );
}
