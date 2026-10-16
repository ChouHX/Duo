import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Alert,
  Avatar,
  Button,
  Tabs,
  Checkbox,
  DatePicker,
  Input,
  InputNumber,
  Layout,
  Modal,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import { Section } from "./Section";
import { InfoTip } from "./InfoTip";
import { TaskFooter } from "./TaskFooter";
import { ClockSync } from "./ClockSync";
import type { Dayjs } from "dayjs";
import {
  AlarmClock,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
  Settings2,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { api, isLocalWeb } from "./api";
import {
  DuoStatus,
  AccountSettings,
  PurchasePreset,
  RouteNav,
  useRoute,
  type Route,
} from "./LocalPages";
import { ItemRows } from "./ItemRows";
import { PaymentBoard, pendingPayments } from "./Payment";
import {
  resyncClock,
  serverNow,
  toLocalEpoch,
  useClockOffset,
} from "./ClockSync";
import { presetProducts } from "./products";
import {
  itemsFromPreset,
  itemsText,
  itemsValid,
  ownItems,
  presetItems,
  withSku,
} from "./items";
import { AccountPrivacyToggle, useAccountPrivacy } from "./AccountPrivacy";
import { AccountGate } from "./AccountGate";
import { RemoveAccountDialog } from "./RemoveAccountDialog";
import { SelectField } from "./SelectField";
import { ActiveTaskNav } from "./ActiveTaskNav";
import {
  active,
  LOCAL_ID,
  localDefaults,
  actionNames,
  stateNames,
  type Account,
  type Action,
  type Data,
  type PresetItem,
  type Prompt,
  type Snapshot,
  type Task,
} from "./types";

// 账号工作台（多账号）：概览 + 批量下单 + 全局购买预设与商品查询
const workspaceTabs = [
  ["home", "工作台"],
  ["batch", "批量下单"],
  ["purchase", "购买预设"],
  ["catalog", "商品"],
] as const;
// 账号页（点击左侧某个账号进入）：该账号的登录、送货方式与购物记录
const accountTabs = [
  ["login", "账号与登录"],
  ["delivery", "送货方式"],
  ["bag", "购物袋"],
  ["orders", "订单"],
] as const;
type Schedule = {
  at: number;
  warmup: number;
  items: PresetItem[];
  accounts: string[];
  createdAt: number;
};
const SCHEDULE_KEY = "duo-killer-schedule";
function readSchedule(): Schedule | null {
  try {
    const raw = localStorage.getItem(SCHEDULE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Schedule;
    return typeof value?.at === "number" && Array.isArray(value.items)
      ? value
      : null;
  } catch {
    return null;
  }
}
function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const clock = `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return hours ? `${hours} 小时 ${clock}` : `${minutes} 分 ${rest} 秒`;
}
const initial: Snapshot = {
  accounts: [],
  tasks: [],
  data_dir: "",
};
const statusColor: Record<string, string> = {
  queued: "default",
  running: "processing",
  waiting: "warning",
  succeeded: "success",
  failed: "error",
  cancelled: "default",
  interrupted: "warning",
};
const errorText = (e: unknown) =>
  typeof e === "string"
    ? e
    : e instanceof Error
      ? e.message
      : "操作未完成，请重试。";

export default function App() {
  const { format, setRevealed } = useAccountPrivacy();
  const [route, goTo] = useRoute();
  const [snapshot, setSnapshot] = useState(initial);
  const [ready, setReady] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [enabledIds, setEnabledIds] = useState<string[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [tab, setTab] = useState("home");
  const [adding, setAdding] = useState(false);
  // 回到账号工作台时若仍在添加流程，落在"工作台"页签（账号门在那里）。
  const navigate = (next: Route) => {
    if (next === "workspace" && adding) setTab("home");
    goTo(next);
  };
  const [error, setError] = useState("");
  const [dispatching, setDispatching] = useState(false);
  const [items, setItems] = useState<PresetItem[]>(() => presetItems());
  const [scheduleAt, setScheduleAt] = useState<Dayjs | null>(null);
  const [warmupMinutes, setWarmupMinutes] = useState(5);
  const [schedule, setSchedule] = useState<Schedule | null>(readSchedule);
  const [now, setNow] = useState(() => serverNow());
  const [taskTarget, setTaskTarget] = useState<Task | null>(null);
  const [focusTaskId, setFocusTaskId] = useState("");
  const [removingAccount, setRemovingAccount] = useState<Account | null>(null);
  const [accountGateVersion, setAccountGateVersion] = useState(0);
  const bridge = api;
  const clockOffset = useClockOffset();
  useEffect(() => {
    const id = window.setInterval(() => setNow(serverNow()), 1000);
    return () => window.clearInterval(id);
  }, [clockOffset]);
  useEffect(() => {
    if (schedule) localStorage.setItem(SCHEDULE_KEY, JSON.stringify(schedule));
    else localStorage.removeItem(SCHEDULE_KEY);
  }, [schedule]);
  useEffect(() => {
    if (!bridge) {
      setReady(true);
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await bridge.subscribe((task) => {
        const removed =
          task.status === "failed" && task.result?.account_removed === true;
        if (removed) {
          setError(task.stage);
          setEnabledIds((ids) => ids.filter((id) => id !== task.account_id));
          setAccountId((id) => (id === task.account_id ? "" : id));
        }
        setSnapshot((s) => ({
          ...s,
          tasks: [task, ...s.tasks.filter((t) => t.id !== task.id)],
          accounts: removed
            ? s.accounts.filter((a) => a.id !== task.account_id)
            : task.status === "succeeded" &&
                ["me", "enroll"].includes(task.action) &&
                task.result?.success === true &&
                task.result?.logged_in === true &&
                task.result?.scope === "account"
              ? s.accounts.map((a) =>
                  a.id === task.account_id
                    ? {
                        ...a,
                        name:
                          typeof task.result?.name === "string" &&
                          task.result.name.trim()
                            ? task.result.name.trim()
                            : a.email,
                        pending: task.action === "enroll" ? false : a.pending,
                      }
                    : a,
                )
              : s.accounts,
        }));
      });
      const state = await bridge.snapshot();
      if (!disposed) {
        setSnapshot(state);
        setReady(true);
      } else unlisten();
    })().catch((e) => {
      if (!disposed) {
        setError(errorText(e));
        setReady(true);
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [bridge]);
  // 购买预设是全局的：统一以"通用预设"（新账号默认值）为基准。
  const globalDefaults = snapshot.defaults || localDefaults;
  const account =
    snapshot.accounts.find((a) => a.id === accountId) ||
    (accountId === LOCAL_ID ? globalDefaults : undefined);
  // 刷新/切换账号后，当前页签可能不属于这个页面：自动落到该页面的第一个页签。
  const activeTabs =
    route === "account"
      ? account?.id === LOCAL_ID
        ? (["delivery"] as string[])
        : accountTabs.map(([id]) => id as string)
      : workspaceTabs.map(([id]) => id as string);
  useEffect(() => {
    if (!activeTabs.includes(tab)) setTab(activeTabs[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, account?.id, tab]);
  useLayoutEffect(() => setRevealed(false), [accountId, setRevealed]);
  const readyIds = snapshot.accounts
    .filter((a) => !a.pending)
    .map((a) => a.id)
    .join(",");
  useEffect(() => {
    if (!ready) return;
    const ids = readyIds ? readyIds.split(",") : [];
    setEnabledIds(ids);
    setAccountId((current) => {
      // 通用预设不是"账号列表"里的一员，但要允许停留在它上面。
      if (current && (current === LOCAL_ID || ids.includes(current)))
        return current;
      const remembered = localStorage.getItem("duo-killer-account");
      if (remembered && (remembered === LOCAL_ID || ids.includes(remembered)))
        return remembered;
      return ids[0] || "";
    });
  }, [ready, readyIds]);
  useEffect(() => {
    if (accountId) localStorage.setItem("duo-killer-account", accountId);
  }, [accountId]);
  useEffect(() => {
    if (ready && !readyIds) setAdding(true); // 没有已登录账号：直接进入添加流程
  }, [ready, readyIds]);
  // 下单表单的默认商品：通用预设（新账号默认）优先，其次账号自己的预设。
  const presetSignature = JSON.stringify([
    globalDefaults.preset_items,
    globalDefaults.preset_sku,
    globalDefaults.preset_quantity,
    account?.id,
    account?.preset_items,
    account?.preset_sku,
    account?.preset_quantity,
  ]);
  useEffect(() => {
    setItems(
      presetItems(
        ownItems(globalDefaults).length ? globalDefaults : account,
        globalDefaults,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetSignature]);
  const tasks = snapshot.tasks
    .filter((t) => t.account_id === accountId)
    .sort((a, b) => b.created_at - a.created_at || b.updated_at - a.updated_at);
  const busy = tasks.some(active) || dispatching;
  const waiting = tasks.find((t) => t.status === "waiting");
  const task =
    tasks.find((t) => t.id === taskTarget?.id && active(t)) ||
    waiting ||
    tasks.find(active) ||
    tasks[0];
  const latest = (actions: Action[]) =>
    tasks.find((t) => actions.includes(t.action) && t.status === "succeeded")
      ?.result ?? undefined;
  const person = latest(["me", "enroll"]);
  const catalogResult = snapshot.tasks
    .filter(
      (t) =>
        t.account_id === LOCAL_ID &&
        t.action === "catalog" &&
        t.status === "succeeded",
    )
    .sort((a, b) => b.updated_at - a.updated_at)[0]?.result;
  const activeTasks = snapshot.tasks
    .filter(active)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  const allActive = activeTasks.length;
  // 不再需要"选择本次使用的账号"：所有已完成登录的账号默认启用。
  const enabledAccounts = snapshot.accounts.filter((a) => !a.pending);
  const pendingAccounts = snapshot.accounts.filter((a) => a.pending);
  // 每个账号的登录状态来自最近一次 me / enroll / login 结果，供侧边栏标识。
  const accountState = (id: string) => {
    const rows = snapshot.tasks
      .filter(
        (t) =>
          t.account_id === id &&
          ["me", "enroll", "login"].includes(t.action) &&
          t.result?.account_removed !== true,
      )
      .sort(
        (a, b) => b.created_at - a.created_at || b.updated_at - a.updated_at,
      );
    const row = rows[0];
    if (!row) return { key: "idle", label: "尚未检查登录", at: 0 };
    if (active(row))
      return { key: "running", label: "正在检查登录", at: row.updated_at };
    if (row.status === "succeeded" && row.result?.logged_in === true)
      return {
        key: "ok",
        label: `已确认登录 · ${new Date(row.updated_at * 1000).toLocaleString("zh-CN")}`,
        at: row.updated_at,
      };
    if (row.status === "failed" || row.result?.logged_in === false)
      return {
        key: "failed",
        label: `上次检查未通过 · ${new Date(row.updated_at * 1000).toLocaleString("zh-CN")}`,
        at: row.updated_at,
      };
    return {
      key: "idle",
      label: `上次结果：${row.stage || "未知"}`,
      at: row.updated_at,
    };
  };
  // 添加账号流程占用工作台的"工作台"页签；主动切到其他页签/账号页时以那里为准。
  const viewingGate =
    route === "workspace" &&
    tab === "home" &&
    adding &&
    (!taskTarget || taskTarget.action === "enroll");
  const latestTask = snapshot.tasks
    .slice()
    .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))[0];
  // 底部提示条展示的任务：账号门里已经有同一份提示时不再重复显示；
  // 公开页面（DUO 状态）显示最近一次公开查询任务，账号页显示当前账号的任务。
  const visibleTabs =
    route === "account"
      ? account?.id === LOCAL_ID
        ? accountTabs.filter(([id]) => id === "delivery")
        : accountTabs
      : workspaceTabs;
  const footerTask = viewingGate
    ? undefined
    : route === "duo"
      ? latestTask
      : route === "pay"
        ? activeTasks.find((t) => t.prompt) || activeTasks[0]
        : task || (latestTask && active(latestTask) ? latestTask : undefined);
  const settingsTarget =
    taskTarget &&
    [
      "address_read",
      "address_save",
      "region",
      "region_options",
      "stores",
      "store_save",
    ].includes(taskTarget.action)
      ? taskTarget
      : null;
  function openTask(target: Task) {
    setTaskTarget(target);
    setFocusTaskId(target.id);
    if (target.account_id === LOCAL_ID) {
      if (target.action === "catalog") {
        navigate("duo");
        return;
      }
      // 通用预设的地址/门店设置属于账号页的送货方式。
      setAccountId(LOCAL_ID);
      setTab("delivery");
      navigate("account");
      return;
    }
    if (
      [
        "address_read",
        "address_save",
        "region",
        "region_options",
        "stores",
        "store_save",
      ].includes(target.action)
    ) {
      setAccountId(target.account_id);
      setTab("delivery");
      navigate("account");
      return;
    }
    // 正在添加的账号：回到"添加账号"流程，密码/验证码提示就在那里。
    const owner = snapshot.accounts.find((a) => a.id === target.account_id);
    if (target.action === "enroll" && (!owner || owner.pending)) {
      setAccountId(target.account_id);
      setAdding(true);
      setTab("home");
      navigate("workspace");
      return;
    }
    setAccountId(target.account_id);
    setTab(
      target.action === "orders"
        ? "orders"
        : ["bag", "checkout"].includes(target.action)
          ? "bag"
          : target.action === "catalog"
            ? "catalog"
            : "login",
    );
    navigate("account");
  }
  useEffect(() => {
    if (!focusTaskId) return;
    const frame = requestAnimationFrame(() => {
      const panel = document.getElementById(`task-${focusTaskId}`);
      if (!panel || !panel.getClientRects().length) return;
      panel.scrollIntoView({ block: "center", behavior: "instant" });
      panel.focus({ preventScroll: true });
      setFocusTaskId("");
    });
    return () => cancelAnimationFrame(frame);
  });
  async function startFor(
    accountId: string,
    action: Action,
    params: Data = {},
  ) {
    if (!bridge) return;
    setError("");
    setDispatching(true);
    try {
      await bridge.start(accountId, action, params);
      setSnapshot(await bridge.snapshot());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDispatching(false);
    }
  }
  async function start(action: Action, params: Data = {}) {
    if (!bridge || !account) return;
    setError("");
    setDispatching(true);
    try {
      await bridge.start(account.id, action, params);
      const state = await bridge.snapshot();
      setSnapshot(state);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDispatching(false);
    }
  }
  // 多账号并发：一次把同一款商品下给所有启用账号，各账号按自己的本地预设执行。
  const checking = useRef(false);
  const autoChecked = useRef(false);
  async function waitForTask(id: string) {
    for (let i = 0; i < 90; i++) {
      const state = await bridge!.snapshot();
      setSnapshot(state);
      const row = state.tasks.find((t) => t.id === id);
      // 需要用户输入（例如密码）时不要卡住后续账号的检查。
      if (!row || !active(row) || row.status === "waiting") return row;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return undefined;
  }
  // 逐个账号检查登录（并发太多容易被官网限流），结果直接反映到侧边栏圆点上。
  async function checkLogins(targets: Account[]) {
    if (!bridge || checking.current || !targets.length) return;
    checking.current = true;
    setDispatching(true);
    setError("");
    try {
      for (const target of targets) {
        try {
          await waitForTask(await bridge.start(target.id, "me", {}));
        } catch (e) {
          setError(`${format(target.name)}：${errorText(e)}`);
        }
      }
      setSnapshot(await bridge.snapshot());
    } finally {
      checking.current = false;
      setDispatching(false);
    }
  }
  // 启动后自动补检：只查"没有记录 / 记录超过 6 小时 / 上次中断"的账号。
  useEffect(() => {
    if (!ready || !bridge || autoChecked.current) return;
    autoChecked.current = true;
    const stale = snapshot.accounts.filter((a) => {
      if (a.pending) return false;
      const state = accountState(a.id);
      return (
        state.key !== "ok" || !state.at || Date.now() / 1000 - state.at > 21600
      );
    });
    if (stale.length) void checkLogins(stale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  async function startBatch() {
    if (!bridge) return;
    setBatchOpen(false);
    setError("");
    setDispatching(true);
    const failed: string[] = [];
    try {
      for (const target of enabledAccounts) {
        try {
          await bridge.start(target.id, "purchase", { items });
        } catch (e) {
          failed.push(`${format(target.name)}：${errorText(e)}`);
        }
      }
      setSnapshot(await bridge.snapshot());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDispatching(false);
    }
    // 下单结果（付款二维码）统一在「付款码」页按账号展示。
    setTab("home");
    navigate("pay");
    if (failed.length) setError(`部分账号未能开始下单：${failed.join("；")}`);
  }
  // 付款码页上针对单个账号的操作（重新取二维码、查询订单、取消任务）。
  function payStart(accountId: string, action: Action, params: Data = {}) {
    void startFor(accountId, action, params);
  }
  function payOrders(accountId: string) {
    setAccountId(accountId);
    setTab("orders");
    navigate("account");
    void startFor(accountId, "orders");
  }
  const scheduleTasks = schedule
    ? snapshot.tasks.filter(
        (t) =>
          t.action === "timed_purchase" &&
          schedule.accounts.includes(t.account_id),
      )
    : [];
  const scheduleRunning = scheduleTasks.some(active);
  const remaining = schedule ? schedule.at * 1000 - now : 0;
  // 临近到点时再校一次网络时间，避免本机时钟漂移影响发射时刻。
  useEffect(() => {
    if (schedule && remaining > 0 && remaining < 60_000) resyncClock();
  }, [schedule, Math.floor(remaining / 10_000)]);
  async function startSchedule() {
    if (!bridge || !scheduleAt) return;
    if (!itemsValid(items)) {
      setError("请先填写有效的商品 SKU 与数量。");
      return;
    }
    if (enabledAccounts.length === 0) {
      setError("还没有可下单的账号。");
      return;
    }
    const at = toLocalEpoch(scheduleAt.toDate());
    if (at * 1000 <= serverNow()) {
      setError("抢购时间必须晚于当前时间（按网络时间）。");
      return;
    }
    resyncClock();
    setError("");
    setDispatching(true);
    const started: string[] = [];
    const failed: string[] = [];
    const params = { at, warmup: warmupMinutes * 60, items };
    for (const target of enabledAccounts) {
      try {
        await bridge.start(target.id, "timed_purchase", params);
        started.push(target.id);
      } catch (e) {
        failed.push(`${format(target.name)}：${errorText(e)}`);
      }
    }
    try {
      setSnapshot(await bridge.snapshot());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDispatching(false);
    }
    if (started.length) {
      setSchedule({
        at,
        warmup: warmupMinutes * 60,
        items,
        accounts: started,
        createdAt: Date.now(),
      });
      setTab("home");
      navigate("pay");
    }
    if (failed.length)
      setError(`部分账号未能开始定时抢购：${failed.join("；")}`);
  }
  async function cancelSchedule() {
    if (!bridge) return;
    for (const task of scheduleTasks.filter(active)) {
      try {
        await bridge.cancel(task.account_id, task.id);
      } catch (e) {
        setError(errorText(e));
      }
    }
    setSchedule(null);
  }
  async function answer(task: Task, value: unknown) {
    if (!bridge || !task.prompt) return;
    const answeredPrompt = task.prompt.id;
    await bridge.reply(task.account_id, task.id, task.prompt.id, value);
    setSnapshot((s) => ({
      ...s,
      tasks: s.tasks.map((t) =>
        t.id === task.id && t.prompt?.id === answeredPrompt
          ? { ...t, prompt: null, status: "running", stage: "继续执行" }
          : t,
      ),
    }));
  }
  const cancel = (t: Task) =>
    bridge?.cancel(t.account_id, t.id).catch((e) => setError(errorText(e)));
  async function refreshSnapshot() {
    if (bridge) setSnapshot(await bridge.snapshot());
  }
  async function removeAccount(target: Account) {
    if (!bridge) return;
    await bridge.remove(target.id);
    if (snapshot.accounts.length === 1) setAccountGateVersion((v) => v + 1);
    const remaining = enabledIds.filter((id) => id !== target.id);
    setSnapshot((s) => ({
      ...s,
      accounts: s.accounts.filter((a) => a.id !== target.id),
      tasks: s.tasks.filter((t) => t.account_id !== target.id),
    }));
    setEnabledIds(remaining);
    if (accountId === target.id) setAccountId(remaining[0] || "");
    if (!remaining.length) {
      // 账号全部移除后回到"添加账号"页面（账号门只在工作台页签渲染）。
      setAdding(true);
      setTab("home");
      navigate("workspace");
    }
    setTaskTarget((t) => (t?.account_id === target.id ? null : t));
    setFocusTaskId("");
    setError("");
    setRevealed(false);
  }
  const publicPage =
    bridge &&
    (route === "duo" ? (
      <DuoStatus
        snapshot={snapshot}
        bridge={bridge}
        refresh={refreshSnapshot}
      />
    ) : null);
  const payPage =
    bridge && route === "pay" ? (
      <PaymentBoard
        snapshot={snapshot}
        busy={busy || dispatching}
        onStart={payStart}
        onOrders={payOrders}
        onCancel={cancel}
        header={
          schedule ? (
            <div className="schedule-countdown" role="status">
              定时抢购 {new Date(schedule.at * 1000).toLocaleString("zh-CN")}
              {remaining > 0
                ? ` · 距抢购 ${formatDuration(remaining / 1000)}${
                    remaining / 1000 > schedule.warmup
                      ? `（${formatDuration(remaining / 1000 - schedule.warmup)} 后开始预热）`
                      : "（正在预热）"
                  }`
                : " · 已到点，正在下单…"}
            </div>
          ) : undefined
        }
      />
    ) : null;
  return (
    <Layout className="app-shell">
      <Layout.Sider width={272} className="sidebar" theme="light">
        <div className="brand">
          <span>
            DUO Killer <small>{isLocalWeb ? "本地 Web" : "桌面版"}</small>
          </span>
        </div>
        <RouteNav
          route={route}
          navigate={navigate}
          counts={{ pay: pendingPayments(snapshot) }}
        />
        {ready && (
          <>
            <div className="sidebar-heading">
              <span>我的账号</span>
              <Button
                type="text"
                size="small"
                aria-label="添加账号"
                disabled={!bridge}
                icon={<Plus />}
                onClick={() => {
                  setTaskTarget(null);
                  setAdding(true);
                  setTab("home");
                  navigate("workspace");
                }}
              />
            </div>
            <nav className="accounts" aria-label="切换账号">
              {enabledAccounts.map((a) => {
                const running = snapshot.tasks.find(
                  (t) => t.account_id === a.id && active(t),
                );
                return (
                  <Button
                    key={a.id}
                    type="text"
                    block
                    className="account"
                    title={format(`${a.name}（${a.email}）`)}
                    aria-current={a.id === accountId ? "true" : undefined}
                    onClick={() => {
                      setAccountId(a.id);
                      setTab("login");
                      navigate("account");
                      setError("");
                    }}
                  >
                    <Avatar size={32}>
                      {a.name.slice(0, 1).toUpperCase()}
                    </Avatar>
                    <span className="account-copy">
                      <strong>{format(a.name)}</strong>
                      <small>{format(a.email)}</small>
                    </span>
                    <span
                      className={`dot ${running ? running.status : accountState(a.id).key}`}
                      title={
                        running
                          ? stateNames[running.status]
                          : accountState(a.id).label
                      }
                    />
                  </Button>
                );
              })}
              {pendingAccounts.map((a) => (
                <Button
                  key={a.id}
                  type="text"
                  block
                  className="account pending"
                  title={`${format(a.name)}（${format(a.email)}）未完成登录`}
                  disabled={!bridge}
                  onClick={() => {
                    setAccountId(a.id);
                    setTab("login");
                    navigate("account");
                    setError("");
                  }}
                >
                  <Avatar size={32}>{a.name.slice(0, 1).toUpperCase()}</Avatar>
                  <span className="account-copy">
                    <strong>{format(a.name)}</strong>
                    <small>未完成登录 · 点击继续</small>
                  </span>
                </Button>
              ))}
            </nav>
            <Button
              type="text"
              block
              className="account account-preset"
              title="通用预设（新账号默认继承）"
              disabled={!bridge}
              onClick={() => {
                setAccountId(LOCAL_ID);
                setTab("delivery");
                navigate("account");
                setError("");
              }}
            >
              <Settings2 aria-hidden />
              <span className="account-copy">
                <strong>通用预设</strong>
                <small>新账号默认继承</small>
              </span>
            </Button>
            {!snapshot.accounts.length && (
              <Typography.Paragraph type="secondary" className="sidebar-note">
                还没有账号，点上方 + 添加。
                <br />
                各账号的会话与预设独立保存。
              </Typography.Paragraph>
            )}
          </>
        )}
        <div className="sidebar-footer">
          <ClockSync />
        </div>
      </Layout.Sider>
      <Layout className="workspace">
        <Layout.Header className="topbar">
          {route === "account" && account ? (
            <div className="topbar-account">
              <strong>{format(account.name)}</strong>
              <span className="account-identity">
                <span>{format(account.email)}</span>
              </span>
              <span className="identity">
                {person?.logged_in ? (
                  <>
                    <CheckCircle2 />
                    <span>上次检查：已确认</span>
                  </>
                ) : (
                  <>
                    <UserRound />
                    <span>登录状态待检查</span>
                  </>
                )}
              </span>
            </div>
          ) : (
            <span className="topbar-route">
              {route === "duo" ? "DUO 状态" : "账号工作台"}
            </span>
          )}
          <div className="topbar-tools">
            <AccountPrivacyToggle />
            {allActive ? (
              <ActiveTaskNav
                tasks={activeTasks}
                accounts={snapshot.accounts}
                onSelect={openTask}
              />
            ) : (
              <Tag>本地工作空间</Tag>
            )}
          </div>
        </Layout.Header>
        <Layout.Content className="page-content">
          {error && (
            <Alert
              type="error"
              showIcon
              closable
              title={format(error)}
              onClose={() => setError("")}
              style={{ marginBottom: 12 }}
            />
          )}
          {ready && bridge && (adding || !snapshot.accounts.length) && (
            <div
              className="setup-content"
              hidden={route !== "workspace" || !viewingGate}
            >
              <AccountGate
                key={accountGateVersion}
                snapshot={snapshot}
                bridge={bridge}
                refresh={refreshSnapshot}
                onRemove={setRemovingAccount}
                onBack={
                  snapshot.accounts.length ? () => setAdding(false) : undefined
                }
                onDone={(ids) => {
                  setAccountId(ids[0]);
                  setAdding(false);
                  setTab("login");
                  navigate("account");
                  setError("");
                }}
                renderForm={(submit, cancelForm) => (
                  <AccountForm onSubmit={submit} onCancel={cancelForm} />
                )}
                renderPrompt={(task, cancelTask) => (
                  <PromptForm
                    key={task.prompt!.id}
                    prompt={task.prompt!}
                    onReply={(value) => answer(task, value)}
                    onCancel={cancelTask}
                  />
                )}
              />
            </div>
          )}
          {!ready ? (
            <div className="empty">
              <Spin indicator={<LoaderCircle className="spin" />} />{" "}
              正在读取本地配置
            </div>
          ) : !bridge ? (
            <div className="empty">
              <Typography.Title level={3}>请在桌面应用中打开</Typography.Title>
              <Typography.Paragraph>
                浏览器预览不会访问你的账号。启动 DUO Killer
                桌面版后，即可管理本机任务。
              </Typography.Paragraph>
              <code>pnpm desktop</code>
            </div>
          ) : payPage ? (
            payPage
          ) : publicPage ? (
            <div className="public-view">{publicPage}</div>
          ) : (
            <>
              {visibleTabs.length > 1 && (
                <Tabs
                  className="workspace-tabs"
                  activeKey={tab}
                  onChange={setTab}
                  items={visibleTabs.map(([id, label]) => ({ key: id, label }))}
                />
              )}
              <div className="content-grid">
                <main>
                  <div className="view-content" key={`${route}-${tab}`}>
                    {viewingGate ? null : route === "account" ? (
                      account ? (
                        <>
                          {tab === "login" && (
                            <Section
                              className="section"
                              title="账号与登录"
                              extra={
                                <Typography.Text type="secondary">
                                  {latest(["me", "enroll", "login"])
                                    ?.device_trust_saved
                                    ? "本机设备信任已保存"
                                    : "设备验证后自动记住本机"}
                                </Typography.Text>
                              }
                            >
                              <Typography.Paragraph type="secondary">
                                {account.pending
                                  ? "这个账号还没完成添加：点“继续登录”完成密码与验证码，成功后才会加入账号列表。"
                                  : "登录时优先复用本机设备信任；信任失效或 Apple 再次要求验证时，才需输入验证码。首次登录会打开一个小型浏览器窗口。"}
                              </Typography.Paragraph>
                              <Space wrap>
                                {account.pending && (
                                  <Button
                                    type="primary"
                                    disabled={busy}
                                    onClick={() => start("enroll")}
                                  >
                                    继续登录
                                  </Button>
                                )}
                                <Button
                                  icon={<RefreshCw />}
                                  disabled={busy}
                                  onClick={() => start("me")}
                                >
                                  检查登录
                                </Button>
                                <Button
                                  disabled={busy}
                                  onClick={() => start("login")}
                                >
                                  登录
                                </Button>
                                <Button
                                  type="link"
                                  disabled={busy}
                                  onClick={() => start("login", { sms: true })}
                                >
                                  使用短信验证
                                </Button>
                                <Button
                                  type="link"
                                  danger
                                  icon={<Trash2 />}
                                  disabled={busy}
                                  title={
                                    busy
                                      ? "请完成或取消该账号的任务后再移除"
                                      : "清除这个账号的本机数据"
                                  }
                                  onClick={() => setRemovingAccount(account)}
                                >
                                  移除账号
                                </Button>
                              </Space>
                            </Section>
                          )}
                          {tab === "delivery" && (
                            <AccountSettings
                              snapshot={snapshot}
                              bridge={bridge}
                              refresh={refreshSnapshot}
                              account={account}
                              startGeneral={(action, params) =>
                                startFor(LOCAL_ID, action, params)
                              }
                            />
                          )}
                          {tab === "bag" && (
                            <Section
                              className="section"
                              title="整个购物袋"
                              extra={
                                <Button
                                  icon={<RefreshCw />}
                                  disabled={busy}
                                  onClick={() => start("bag")}
                                >
                                  刷新
                                </Button>
                              }
                            >
                              <Typography.Paragraph type="secondary">
                                读取所选账号的实时购物袋，结算时可选择配送或自提。
                              </Typography.Paragraph>
                              {latest(["bag"]) ? (
                                <ItemTable
                                  items={latest(["bag"])!.items || []}
                                  total={latest(["bag"])!.total}
                                />
                              ) : (
                                <InlineEmpty text="点击刷新，查看当前账号的购物袋。" />
                              )}
                              <Button
                                type="primary"
                                icon={<ArrowRight />}
                                iconPosition="end"
                                disabled={busy}
                                onClick={() => start("checkout")}
                              >
                                结算购物袋
                              </Button>
                            </Section>
                          )}
                          {tab === "orders" && (
                            <Section
                              className="section"
                              title="我的订单"
                              extra={
                                <Button
                                  icon={<RefreshCw />}
                                  disabled={busy}
                                  onClick={() => start("orders")}
                                >
                                  查询订单
                                </Button>
                              }
                            >
                              <Typography.Paragraph type="secondary">
                                支付完成后主动查询，确认 Apple
                                返回的最新订单状态。
                              </Typography.Paragraph>
                              {latest(["orders"]) ? (
                                <OrderTable result={latest(["orders"])!} />
                              ) : (
                                <InlineEmpty text="点击查询订单，读取官网订单列表。" />
                              )}
                            </Section>
                          )}
                        </>
                      ) : (
                        <div className="empty">
                          <Typography.Paragraph>
                            当前没有启用的账号，可选择左侧其他账号或自行添加。
                          </Typography.Paragraph>
                          <Button
                            onClick={() => {
                              setAdding(true);
                              setTab("home");
                              navigate("workspace");
                            }}
                          >
                            添加账号
                          </Button>
                        </div>
                      )
                    ) : (
                      <>
                        {tab === "home" && (
                          <>
                            <Section
                              className="section"
                              title="各账号进度"
                              extra={
                                <Button
                                  icon={<RefreshCw />}
                                  disabled={
                                    busy ||
                                    !bridge ||
                                    enabledAccounts.length === 0
                                  }
                                  onClick={() =>
                                    void checkLogins(enabledAccounts)
                                  }
                                >
                                  检查所有账号登录
                                </Button>
                              }
                            >
                              <Table
                                size="small"
                                rowKey={(row: Account) => row.id}
                                pagination={false}
                                dataSource={enabledAccounts}
                                locale={{
                                  emptyText: "还没有账号，点左侧 + 添加。",
                                }}
                                onRow={(row: Account) => ({
                                  onClick: () => {
                                    setAccountId(row.id);
                                    setTab("login");
                                    navigate("account");
                                  },
                                  style: { cursor: "pointer" },
                                })}
                                columns={[
                                  {
                                    title: "账号",
                                    render: (_: unknown, row: Account) =>
                                      format(row.name),
                                  },
                                  {
                                    title: "邮箱",
                                    render: (_: unknown, row: Account) =>
                                      format(row.email),
                                  },
                                  {
                                    title: "登录状态",
                                    render: (_: unknown, row: Account) => {
                                      const state = accountState(row.id);
                                      return (
                                        <span
                                          className={`account-state ${state.key}`}
                                        >
                                          {state.label}
                                        </span>
                                      );
                                    },
                                  },
                                  {
                                    title: "预设商品",
                                    render: (_: unknown, row: Account) =>
                                      itemsFromPreset(row),
                                  },
                                  {
                                    title: "进行中的任务",
                                    render: (_: unknown, row: Account) => {
                                      const running = snapshot.tasks.filter(
                                        (t) =>
                                          t.account_id === row.id && active(t),
                                      );
                                      if (!running.length) return "空闲";
                                      return running
                                        .map(
                                          (t) =>
                                            `${actionNames[t.action]}（${stateNames[t.status]}）`,
                                        )
                                        .join("、");
                                    },
                                  },
                                ]}
                              />
                            </Section>
                          </>
                        )}
                        {tab === "purchase" && (
                          <PurchasePreset
                            key="purchase-global"
                            account={globalDefaults}
                            bridge={bridge}
                            refresh={refreshSnapshot}
                            follow={enabledAccounts}
                          />
                        )}
                        {tab === "catalog" && (
                          <>
                            <Section
                              className="section"
                              title="预制商品"
                              info={
                                <InfoTip label="预制商品说明">
                                  预设参考价格；实际金额以结账页为准。点选即填入批量下单。
                                </InfoTip>
                              }
                              extra={
                                <Button onClick={() => navigate("duo")}>
                                  查看 DUO 状态
                                </Button>
                              }
                            >
                              <Catalog
                                result={{
                                  items: presetProducts,
                                  note: "预设参考价格；实际金额以结账页为准。",
                                }}
                                onSelect={(value) => {
                                  setItems((current) =>
                                    withSku(current, value),
                                  );
                                  setTab("batch");
                                }}
                              />
                            </Section>
                            <Section
                              className="section"
                              title="官网商品"
                              info={
                                <InfoTip label="官网商品说明">
                                  商品与可加购状态来自官网，不代表当前库存。
                                </InfoTip>
                              }
                            >
                              <Space wrap style={{ marginBottom: 12 }}>
                                <Button
                                  disabled={busy}
                                  onClick={() =>
                                    void startFor(LOCAL_ID, "catalog")
                                  }
                                >
                                  全部推荐
                                </Button>
                                <Button
                                  disabled={busy}
                                  onClick={() =>
                                    void startFor(LOCAL_ID, "catalog", {
                                      mode: "phone",
                                    })
                                  }
                                >
                                  iPhone
                                </Button>
                                <Button
                                  disabled={busy}
                                  onClick={() =>
                                    void startFor(LOCAL_ID, "catalog", {
                                      mode: "duo",
                                    })
                                  }
                                >
                                  iPhone Duo
                                </Button>
                              </Space>
                              {catalogResult ? (
                                <Catalog
                                  result={catalogResult}
                                  onSelect={(value) => {
                                    setItems((current) =>
                                      withSku(current, value),
                                    );
                                    setTab("batch");
                                  }}
                                />
                              ) : (
                                <InlineEmpty text="选择一个分类，查询商品与 SKU。" />
                              )}
                            </Section>
                          </>
                        )}
                        {tab === "batch" && (
                          <Section
                            className="section"
                            title="批量下单（所有启用账号）"
                          >
                            <Typography.Paragraph type="secondary">
                              一次把同一款商品提交给所有启用账号，各账号互不阻塞、并行执行；每个账号都按自己的本地预设结账（配送方式、地址、AppleCare+，没填的字段自动用通用预设）。也可以只给当前选中的账号下单。
                            </Typography.Paragraph>
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                start("purchase", { items });
                              }}
                            >
                              <ItemRows
                                items={items}
                                onChange={setItems}
                                disabled={busy}
                              />
                              <Typography.Paragraph type="secondary">
                                可以一次下单多种商品：按购物袋逐件加购后一起结账（AppleCare+
                                按各商品的内联推荐分别处理）。购物袋已有同一商品时，数量调整为这里填写的总数。
                              </Typography.Paragraph>
                              <Space wrap>
                                <Button
                                  type="primary"
                                  htmlType="submit"
                                  icon={<ArrowRight />}
                                  iconPosition="end"
                                  disabled={busy || !itemsValid(items)}
                                >
                                  立即下单（当前账号）
                                </Button>
                                <Button
                                  icon={<Users />}
                                  disabled={
                                    busy ||
                                    !bridge ||
                                    !itemsValid(items) ||
                                    enabledAccounts.length === 0
                                  }
                                  onClick={() => setBatchOpen(true)}
                                >
                                  并发下单（{enabledAccounts.length} 个账号）
                                </Button>
                              </Space>
                            </form>
                            <div className="schedule">
                              <Typography.Title level={5}>
                                定时抢购
                                <InfoTip label="定时抢购说明">
                                  按上面的商品列表，给所有已启用账号各排一个定时任务：到点前
                                  “提前刷新账号”（重新校验并刷新登录会话、尽量先把商品放进购物袋），
                                  到点立刻结账生成付款二维码。时间以侧边栏的网络时间为准，本机时钟不准也会自动校正；
                                  整点刚开售时加购失败会自动重试。任务执行期间该账号的其他操作会排队。
                                </InfoTip>
                              </Typography.Title>
                              {schedule ? (
                                <Typography.Paragraph type="secondary">
                                  已安排：
                                  {new Date(schedule.at * 1000).toLocaleString(
                                    "zh-CN",
                                  )}
                                  （提前 {Math.round(schedule.warmup / 60)}{" "}
                                  分钟预热）·
                                  {schedule.items
                                    .map(
                                      (item) =>
                                        `${item.sku} × ${item.quantity}`,
                                    )
                                    .join("、")}
                                </Typography.Paragraph>
                              ) : null}
                              <div className="schedule-row">
                                <label>
                                  抢购时间
                                  <DatePicker
                                    showTime={{ format: "HH:mm:ss" }}
                                    format="YYYY-MM-DD HH:mm:ss"
                                    value={scheduleAt}
                                    disabled={busy}
                                    placeholder="选择发售时刻"
                                    onChange={(value) => setScheduleAt(value)}
                                  />
                                </label>
                                <label>
                                  提前预热
                                  <InputNumber
                                    min={0}
                                    max={60}
                                    addonAfter="分钟"
                                    value={warmupMinutes}
                                    disabled={busy}
                                    onChange={(value) =>
                                      setWarmupMinutes(Number(value) || 0)
                                    }
                                  />
                                </label>
                                <Space wrap>
                                  <Button
                                    icon={<AlarmClock />}
                                    disabled={
                                      busy ||
                                      !bridge ||
                                      !scheduleAt ||
                                      !itemsValid(items) ||
                                      enabledAccounts.length === 0
                                    }
                                    onClick={() => void startSchedule()}
                                  >
                                    定时抢购（{enabledAccounts.length} 个账号）
                                  </Button>
                                  {scheduleRunning && (
                                    <Button
                                      danger
                                      onClick={() => void cancelSchedule()}
                                    >
                                      取消定时抢购
                                    </Button>
                                  )}
                                </Space>
                              </div>
                              {schedule ? (
                                <div
                                  className="schedule-countdown"
                                  role="status"
                                >
                                  {remaining > 0 ? (
                                    <>
                                      距抢购 {formatDuration(remaining / 1000)}{" "}
                                      ·
                                      {remaining / 1000 > schedule.warmup
                                        ? `${formatDuration(
                                            remaining / 1000 - schedule.warmup,
                                          )} 后开始预热`
                                        : "正在预热"}
                                    </>
                                  ) : (
                                    <>已到点，正在下单…</>
                                  )}
                                </div>
                              ) : null}
                              {scheduleTasks.length ? (
                                <ul className="schedule-accounts">
                                  {scheduleTasks.map((task) => (
                                    <li key={task.id}>
                                      {format(
                                        snapshot.accounts.find(
                                          (a) => a.id === task.account_id,
                                        )?.name || task.account_id,
                                      )}
                                      ：{stateNames[task.status] || task.status}
                                      {task.stage ? ` · ${task.stage}` : ""}
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                            </div>
                          </Section>
                        )}
                      </>
                    )}
                  </div>
                  <Modal
                    open={batchOpen}
                    title={`并发下单：${enabledAccounts.length} 个账号`}
                    okText="开始下单"
                    cancelText="取消"
                    onCancel={() => setBatchOpen(false)}
                    onOk={() => void startBatch()}
                    okButtonProps={{ disabled: !bridge }}
                  >
                    <Typography.Paragraph>
                      商品：{itemsText(items)}
                    </Typography.Paragraph>
                    <ul className="batch-accounts" aria-label="并发下单的账号">
                      {enabledAccounts.map((a) => (
                        <li key={a.id}>
                          {format(a.name)} · {format(a.email)} · 预设{" "}
                          {itemsFromPreset(a)}
                        </li>
                      ))}
                    </ul>
                    <Typography.Paragraph type="secondary">
                      每个账号各自独立执行：配送方式、地址、AppleCare+
                      都按该账号的本地预设（没填的自动用通用预设）。任务会并行运行，在右上角“进行中的任务”里查看进度；
                      同时提交多个账号可能触发官网限流，失败可单独重试。
                    </Typography.Paragraph>
                  </Modal>
                </main>
              </div>
            </>
          )}
          <div className="page-footer">
            {!footerTask ? (
              <TaskFooter format={format} />
            ) : (
              <TaskFooter
                task={footerTask}
                account={
                  // 提示条属于哪个账号就显示哪个账号：付款码页可能同时有多个账号的任务。
                  snapshot.accounts.find(
                    (a) => a.id === footerTask.account_id,
                  ) ||
                  (account && footerTask.account_id === account.id
                    ? account
                    : undefined)
                }
                format={format}
                onCancel={() => cancel(footerTask)}
              >
                {footerTask.prompt ? (
                  <PromptForm
                    key={footerTask.prompt.id}
                    prompt={footerTask.prompt}
                    onReply={(value) => answer(footerTask, value)}
                    onCancel={() => cancel(footerTask)}
                  />
                ) : null}
                {!footerTask.prompt &&
                  footerTask.status === "succeeded" &&
                  footerTask.result && (
                    <Result
                      task={footerTask}
                      onOrders={() => {
                        setTab("orders");
                        navigate("account");
                        start("orders");
                      }}
                      onPay={() => navigate("pay")}
                      disabled={busy}
                    />
                  )}
                {footerTask.order_submitted &&
                  ["failed", "cancelled", "interrupted"].includes(
                    footerTask.status,
                  ) && (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setTab("orders");
                        navigate("account");
                        start("orders");
                      }}
                    >
                      查询订单，确认提交结果
                    </Button>
                  )}
              </TaskFooter>
            )}
          </div>
          {removingAccount && (
            <RemoveAccountDialog
              account={removingAccount}
              onRemove={() => removeAccount(removingAccount)}
              onClose={() => setRemovingAccount(null)}
            />
          )}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}

function AccountForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (email: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="account-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        await onSubmit(email);
        setSaving(false);
      }}
    >
      <div className="account-form-field">
        <label htmlFor="account-email">Apple 账号</label>
        <div className="field-row">
          <Input
            id="account-email"
            required
            autoFocus
            type="text"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="邮箱或手机号"
          />
          <Button
            type="primary"
            htmlType="submit"
            icon={<Plus />}
            disabled={saving}
          >
            继续登录
          </Button>
          {onCancel && (
            <Button type="link" onClick={onCancel}>
              取消
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
function InlineEmpty({ text }: { text: string }) {
  return (
    <Typography.Paragraph type="secondary" className="inline-empty">
      {text}
    </Typography.Paragraph>
  );
}
function ItemTable({ items, total }: { items: Data[]; total?: string }) {
  const columns = [
    {
      title: "商品",
      render: (_: unknown, item: Data) => (
        <>
          {item.name || item.sku || item.part}
          <br />
          <Typography.Text type="secondary">
            {item.sku || item.part}
          </Typography.Text>
        </>
      ),
    },
    { title: "数量", dataIndex: "quantity", width: 90 },
    {
      title: "小计",
      align: "right" as const,
      render: (_: unknown, item: Data) => item.subtotal || "—",
    },
  ];
  return (
    <>
      <Table
        rowKey={(item) => String(item.sku || item.part || Math.random())}
        size="small"
        pagination={false}
        columns={columns}
        dataSource={items}
        locale={{ emptyText: "购物袋为空。" }}
      />
      {total && (
        <div className="total">
          <span>总支付</span>
          <strong>{total}</strong>
        </div>
      )}
    </>
  );
}
function OrderTable({ result }: { result: Data }) {
  const rows = (result.orders || []).flatMap((order: Data) =>
    (order.items || []).map((item: Data) => ({ order, item })),
  );
  const columns = [
    {
      title: "订单号 / 商品",
      render: (_: unknown, row: Data) => (
        <>
          <Typography.Text code>{row.order.order_number}</Typography.Text>
          <br />
          <Typography.Text type="secondary">{row.item.name}</Typography.Text>
        </>
      ),
    },
    {
      title: "数量",
      width: 90,
      render: (_: unknown, row: Data) => row.item.quantity,
    },
    {
      title: "状态 / 配送",
      render: (_: unknown, row: Data) =>
        row.item.delivery_info || "官网未返回状态",
    },
  ];
  return (
    <>
      <Table
        rowKey={(row) =>
          String(row.order.order_number) + "-" + String(row.item.name)
        }
        size="small"
        pagination={false}
        columns={columns}
        dataSource={rows}
      />
      <Typography.Paragraph type="secondary">
        {result.message}
      </Typography.Paragraph>
    </>
  );
}
function Catalog({
  result,
  onSelect,
}: {
  result: Data;
  onSelect: (sku: string) => void;
}) {
  const rows = (result.items || []).flatMap((item: Data) =>
    item.skus?.length
      ? item.skus.map((s: Data) => ({ ...s, name: s.name || item.name }))
      : item.sku
        ? [item]
        : [{ ...item, sku: "" }],
  );
  const columns = [
    {
      title: "商品 / SKU",
      render: (_: unknown, row: Data) => (
        <>
          {row.name}
          <br />
          <Typography.Text type="secondary">
            {row.sku || row.error || "需在官网选择配置"}
          </Typography.Text>
        </>
      ),
    },
    {
      title: "价格",
      render: (_: unknown, row: Data) => (
        <>
          {row.price != null ? `${row.price} ${row.currency || "CNY"}` : "—"}
          {row.can_add_to_bag === false && (
            <>
              <br />
              <Typography.Text type="secondary">未开放加购</Typography.Text>
            </>
          )}
        </>
      ),
    },
    {
      title: "",
      width: 90,
      render: (_: unknown, row: Data) =>
        row.sku ? (
          <Button size="small" onClick={() => onSelect(row.sku)}>
            选择
          </Button>
        ) : null,
    },
  ];
  return (
    <>
      <Table
        rowKey={(row) => String(row.sku || row.name || Math.random())}
        size="small"
        pagination={false}
        columns={columns}
        dataSource={rows}
      />
      <Typography.Paragraph type="secondary">
        {result.note}
      </Typography.Paragraph>
    </>
  );
}
function Result({
  task,
  onOrders,
  onPay,
  disabled,
}: {
  task: Task;
  onOrders: () => void;
  onPay?: () => void;
  disabled: boolean;
}) {
  const { format } = useAccountPrivacy();
  const result = task.result!;
  if (result.status === "pending_payment")
    return (
      <div className="payment-hint">
        <Typography.Paragraph>
          订单 {result.order_number || "已创建"}
          {result.amount_due ? ` · ${result.amount_due}` : ""}{" "}
          已创建，付款二维码在「付款码」页，一个账号一张卡。
        </Typography.Paragraph>
        {result.delivery_note && (
          <Typography.Paragraph type="secondary">
            {String(result.delivery_note)}
          </Typography.Paragraph>
        )}
        <Button type="primary" onClick={onPay}>
          去付款码页扫码
        </Button>
      </div>
    );
  if (task.action === "me")
    return (
      <Typography.Paragraph>
        <CheckCircle2 />{" "}
        {result.logged_in
          ? format(
              `${result.name ? result.name + " · " : ""}${result.apple_id || result.email || "账号已登录"}`,
            )
          : result.message || "尚未登录"}
      </Typography.Paragraph>
    );
  if (task.action === "login")
    return (
      <Typography.Paragraph>
        <CheckCircle2 /> 商城会话已保存，可继续选购。
      </Typography.Paragraph>
    );
  if (task.action === "add")
    return (
      <Typography.Paragraph>
        <CheckCircle2 /> {result.part} × {result.items?.[0]?.quantity} ·
        购物袋总额 {result.bag_total}
      </Typography.Paragraph>
    );
  if (result.message)
    return <Typography.Paragraph>{result.message}</Typography.Paragraph>;
  return null;
}

function PromptForm({
  prompt,
  onReply,
  onCancel,
}: {
  prompt: Prompt;
  onReply: (value: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const initialSelection =
    prompt.kind === "select"
      ? prompt.options?.findIndex((o) => o.value === prompt.default)
      : -1;
  const { format } = useAccountPrivacy();
  const [value, setValue] = useState(
    prompt.kind === "select"
      ? initialSelection !== undefined && initialSelection >= 0
        ? String(initialSelection)
        : ""
      : String(prompt.default ?? ""),
  );
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (answer: unknown) => {
    setBusy(true);
    setError("");
    try {
      await onReply(answer);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  const confirmation = prompt.kind === "confirm";
  const password = prompt.kind === "password";
  return (
    <form
      className="prompt-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (prompt.kind === "code" && !/^[0-9]{6}$/.test(value)) return;
        let answer: unknown = value;
        if (confirmation) answer = true;
        else if (password) answer = { password: value, remember };
        else if (prompt.kind === "select")
          answer = prompt.options?.find((_, i) => String(i) === value)?.value;
        submit(answer);
      }}
    >
      <Typography.Title level={5}>{format(prompt.label)}</Typography.Title>
      {confirmation ? (
        <>
          <ItemTable
            items={prompt.details?.items || []}
            total={prompt.details?.total}
          />
          {prompt.details?.store && <p>自提门店：{prompt.details.store}</p>}
          {prompt.details?.address && <p>送货地址：{prompt.details.address}</p>}
        </>
      ) : prompt.kind === "select" ? (
        <SelectField
          label="选择一个选项"
          autoFocus
          required
          disabled={busy}
          value={value}
          onChange={setValue}
          options={(prompt.options || []).map((o, i) => ({
            value: String(i),
            label: format(o.label),
          }))}
        />
      ) : (
        <>
          <label className="prompt-field">
            <span>
              {password
                ? "密码"
                : prompt.kind === "code"
                  ? "六位验证码"
                  : "输入内容"}
            </span>
            <div className="input-with-action">
              <Input
                autoFocus
                required={!["text"].includes(prompt.kind)}
                value={value}
                type={password && !show ? "password" : "text"}
                inputMode={prompt.kind === "code" ? "numeric" : undefined}
                maxLength={prompt.kind === "code" ? 6 : undefined}
                autoComplete={
                  password
                    ? "current-password"
                    : prompt.kind === "code"
                      ? "one-time-code"
                      : "off"
                }
                onChange={(e) =>
                  setValue(
                    prompt.kind === "code"
                      ? e.target.value.replace(/[^0-9]/g, "")
                      : e.target.value,
                  )
                }
              />
              {password && (
                <Button
                  type="text"
                  aria-label={show ? "隐藏密码" : "显示密码"}
                  icon={show ? <EyeOff /> : <Eye />}
                  onClick={() => setShow(!show)}
                />
              )}
            </div>
          </label>
          {prompt.kind === "code" && !!prompt.actions?.length && (
            <Space
              className="prompt-actions"
              role="group"
              aria-label="切换验证方式"
            >
              {prompt.actions.map((action) => (
                <Button
                  key={action.value}
                  disabled={busy}
                  onClick={() => submit(action.value)}
                >
                  {action.label}
                </Button>
              ))}
            </Space>
          )}
          {prompt.kind === "code" && (
            <Typography.Paragraph type="secondary" className="prompt-hint">
              验证通过后会保存 Apple
              下发的设备信任，供下次登录复用。六位验证码不会保存。
            </Typography.Paragraph>
          )}
          {password && (
            <Checkbox
              className="prompt-remember"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            >
              保存到系统凭据保险库
            </Checkbox>
          )}
        </>
      )}
      {error && <Alert type="error" showIcon title={error} />}
      <div className="prompt-buttons">
        <Space>
          <Button
            type="primary"
            disabled={busy || (prompt.kind === "select" && value === "")}
            htmlType="submit"
            icon={busy ? <LoaderCircle className="spin" /> : undefined}
          >
            {confirmation ? "确认创建订单" : "继续"}
          </Button>
          <Button
            disabled={busy}
            className="operation-cancel"
            icon={<X />}
            onClick={confirmation ? () => submit(false) : onCancel}
          >
            取消
          </Button>
        </Space>
      </div>
    </form>
  );
}
