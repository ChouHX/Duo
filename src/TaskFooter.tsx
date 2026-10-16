import type { ReactNode } from "react";
import { Button } from "antd";
import { LoaderCircle, X } from "lucide-react";
import {
  actionNames,
  active,
  stateNames,
  type Account,
  type Task,
} from "./types";

/**
 * 固定在右侧容器底部的任务提示条。
 *
 * 一行讲清楚"在做什么 / 结果如何 / 哪一步出错"，不占主容器空间；
 * 需要输入或需要展示结果（付款二维码、商品明细）时才在下面展开。
 */
export function TaskFooter({
  task,
  account,
  format,
  onCancel,
  children,
}: {
  task?: Task;
  account?: Account;
  format: (value?: string) => string;
  onCancel?: () => void;
  children?: ReactNode;
}) {
  if (!task) {
    return (
      <div className="task-footer" role="status">
        <span className="task-footer-dot idle" aria-hidden />
        <span className="task-footer-stage">没有正在进行的任务。</span>
      </div>
    );
  }
  const line = format(
    task.result?.message || task.stage || stateNames[task.status],
  );
  return (
    <section
      className={`task-detail task-footer ${task.status}`}
      id={`task-${task.id}`}
      tabIndex={-1}
      key={task.id}
      data-active={active(task) || undefined}
      aria-label="当前任务"
    >
      <div
        className="task-footer-bar"
        role={task.status === "failed" ? "alert" : "status"}
      >
        <span className={`task-footer-dot ${task.status}`} aria-hidden />
        <strong className="task-footer-title">
          {actionNames[task.action]}
        </strong>
        <span className={`task-footer-state ${task.status}`}>
          {active(task) && task.status !== "waiting" && (
            <LoaderCircle className="spin" />
          )}{" "}
          {stateNames[task.status] || task.status}
        </span>
        {account && (
          <span className="task-account task-footer-account">
            {format(account.email)}
          </span>
        )}
        <span className="task-footer-stage" title={line}>
          {line}
        </span>
        {active(task) && !task.prompt && onCancel && (
          <Button
            size="small"
            type="text"
            className="operation-cancel"
            icon={<X aria-hidden />}
            onClick={onCancel}
          >
            取消
          </Button>
        )}
      </div>
      {children}
    </section>
  );
}
