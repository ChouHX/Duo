import { useEffect, useRef, useState } from "react";
import { Clock } from "lucide-react";

// 网络时间偏移（毫秒，server - local）共享给"定时抢购"用：到点前按校时后的时钟发射。
let offsetMs = 0;
const listeners = new Set<(offset: number) => void>();
let forceResync: (() => void) | null = null;

function publish(offset: number) {
  offsetMs = offset;
  listeners.forEach((listener) => listener(offset));
}

/** 校时后的当前时间（毫秒）。未同步成功时等于本机时间。 */
export const serverNow = () => Date.now() + offsetMs;

/** 把"用户看到的时刻"换算成本机 epoch 秒（喂给 worker 的 at 参数）。 */
export const toLocalEpoch = (date: Date) => (date.getTime() - offsetMs) / 1000;

export function useClockOffset() {
  const [offset, setOffset] = useState(offsetMs);
  useEffect(() => {
    listeners.add(setOffset);
    setOffset(offsetMs);
    return () => {
      listeners.delete(setOffset);
    };
  }, []);
  return offset;
}

/** 立刻重新同步一次网络时间（设置抢购时间、临近到点时调用）。 */
export function resyncClock() {
  forceResync?.();
}

/**
 * 侧边栏底部的网络时间。
 *
 * 通过公开接口取当前时间，算出本机时钟的偏差并显示校时后的北京时间，
 * 便于对着"发售时刻"抢购时判断本机时间准不准。不发送任何账号信息。
 */
const ENDPOINT = "https://timeapi.io/api/Time/current/zone?timeZone=UTC";
const RESYNC_MS = 15 * 60 * 1000;

type Sync = { offset: number; at: number };

export function ClockSync() {
  const [sync, setSync] = useState<Sync | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(() => Date.now());
  const running = useRef(false);

  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const run = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    const startedAt = Date.now();
    try {
      const response = await fetch(ENDPOINT, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const server = Date.UTC(
        Number(data.year),
        Number(data.month) - 1,
        Number(data.day),
        Number(data.hour),
        Number(data.minute),
        Number(data.seconds),
        Number(data.milliSeconds) || 0,
      );
      if (!Number.isFinite(server)) throw new Error("未返回可用时间");
      // 请求往返时间取一半，抵消网络延迟带来的固定偏差。
      const roundTrip = Date.now() - startedAt;
      const offset = server - (startedAt + roundTrip / 2);
      setSync({ offset, at: Date.now() });
      publish(offset);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    forceResync = () => void run();
    void run();
    const id = window.setInterval(() => void run(), RESYNC_MS);
    return () => {
      forceResync = null;
      window.clearInterval(id);
    };
  }, []);

  const corrected = new Date(tick + (sync?.offset ?? 0));
  const time = corrected.toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
  const seconds = (sync?.offset ?? 0) / 1000;
  const drift =
    Math.abs(seconds) < 0.05
      ? "与本机一致"
      : `本机${seconds > 0 ? "慢" : "快"} ${Math.abs(seconds).toFixed(2)} 秒`;
  const status = failed
    ? "同步失败 · 点击重试"
    : sync
      ? `网络时间 · ${drift}`
      : "正在同步…";
  const syncedAt = sync
    ? new Date(sync.at).toLocaleTimeString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "";

  return (
    <button
      type="button"
      className="clock-sync"
      onClick={() => void run()}
      disabled={busy}
      aria-label={`网络时间 ${time}，${status}`}
      title={
        failed
          ? "无法访问网络时间接口，显示的是本机时间；点击重试"
          : `校时后的北京时间；本机时钟偏差 ${seconds >= 0 ? "+" : ""}${seconds.toFixed(2)} 秒${
              syncedAt ? `，上次同步 ${syncedAt}` : ""
            }。点击可重新同步。`
      }
    >
      <Clock aria-hidden />
      <span className="clock-time">{time}</span>
      <small>{status}</small>
    </button>
  );
}
