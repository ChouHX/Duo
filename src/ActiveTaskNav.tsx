import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, CircleDot } from "lucide-react";
import { useAccountPrivacy } from "./AccountPrivacy";
import { actionNames, stateNames, type Account, type Task } from "./types";

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
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const open = expanded && tasks.length > 1;
  useEffect(() => {
    if (tasks.length < 2) setExpanded(false);
  }, [tasks.length]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setExpanded(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);
  if (!tasks.length) return null;
  return (
    <div
      className="active-task-nav"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setExpanded(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setExpanded(false);
          button.current?.focus();
        }
      }}
    >
      <button
        className="active-task-trigger"
        ref={button}
        aria-expanded={tasks.length > 1 ? open : undefined}
        aria-controls={open ? listId : undefined}
        title={tasks.length === 1 ? "回到当前任务" : "选择要查看的任务"}
        onClick={() =>
          tasks.length === 1 ? onSelect(tasks[0]) : setExpanded(!open)
        }
      >
        <CircleDot size={15} aria-hidden="true" />
        {tasks.length} 个任务进行中
        {tasks.length > 1 && <ChevronDown size={14} aria-hidden="true" />}
      </button>
      {open && (
        <ul id={listId} className="active-task-list" aria-label="进行中的任务">
          {tasks.map((task) => {
            const account = accounts.find((a) => a.id === task.account_id);
            return (
              <li key={task.id}>
                <button
                  onClick={() => {
                    setExpanded(false);
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
                  <span className={`status ${task.status}`}>
                    {stateNames[task.status]}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
