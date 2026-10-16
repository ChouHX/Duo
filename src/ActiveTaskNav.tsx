import { useState } from "react";
import { Button, Popover, Tag } from "antd";
import { ChevronDown } from "lucide-react";
import { useAccountPrivacy } from "./AccountPrivacy";
import { actionNames, stateNames, type Account, type Task } from "./types";

const statusColor: Record<string, string> = {
  queued: "default",
  running: "processing",
  waiting: "warning",
  failed: "error",
  cancelled: "default",
  interrupted: "warning",
};

export function ActiveTaskNav({
  tasks,
  accounts,
  onSelect,
}: {
  tasks: Task[];
  accounts: Account[];
  onSelect: (task: Task) => void;
}) {
  const { format } = useAccountPrivacy();
  const [open, setOpen] = useState(false);
  if (!tasks.length) return null;
  const label = `${tasks.length} 个任务进行中`;
  const trigger = (
    <Button
      className="active-task-trigger"
      icon={null}
      onClick={() => tasks.length === 1 && onSelect(tasks[0])}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
      title={tasks.length === 1 ? "回到当前任务" : "选择要查看的任务"}
    >
      {label}
      {tasks.length > 1 && <ChevronDown style={{ fontSize: 10 }} />}
    </Button>
  );
  if (tasks.length === 1) {
    return <div className="active-task-nav">{trigger}</div>;
  }
  return (
    <div className="active-task-nav">
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger="click"
        placement="bottomRight"
        getPopupContainer={(node) => node.parentElement ?? document.body}
        content={
          <ul className="active-task-list" aria-label="进行中的任务">
            {tasks.map((task) => {
              const account = accounts.find((a) => a.id === task.account_id);
              return (
                <li key={task.id}>
                  <Button
                    type="text"
                    block
                    onClick={() => {
                      setOpen(false);
                      onSelect(task);
                    }}
                  >
                    <span className="active-task-label">
                      <strong>
                        {format(account?.name || "通用工作空间")} ·{" "}
                        {actionNames[task.action]}
                      </strong>
                      {account && <small>{format(account.email)}</small>}
                    </span>
                    <Tag color={statusColor[task.status] || "default"}>
                      {stateNames[task.status]}
                    </Tag>
                  </Button>
                </li>
              );
            })}
          </ul>
        }
      >
        {trigger}
      </Popover>
    </div>
  );
}
