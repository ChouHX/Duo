import type { ReactNode } from "react";
import { Button, Card, Space, Spin, Tag, Typography } from "antd";
import { CheckCircle2, LoaderCircle, QrCode, RefreshCw, X } from "lucide-react";
import { Section } from "./Section";
import { useAccountPrivacy } from "./AccountPrivacy";
import {
  actionNames,
  active,
  stateNames,
  type Account,
  type Action,
  type Data,
  type Snapshot,
  type Task,
} from "./types";

/** 会创建订单的动作（结果里带付款二维码）。 */
const ORDER_ACTIONS: Action[] = ["purchase", "timed_purchase", "checkout"];
/** 下单 + 单独重新获取二维码。 */
const PAYMENT_ACTIONS: Action[] = [...ORDER_ACTIONS, "qr"];

const newest = (tasks: Task[]) =>
  tasks
    .slice()
    .sort((a, b) => b.created_at - a.created_at || b.updated_at - a.updated_at);

export function pendingPayment(task?: Task) {
  return task?.result?.status === "pending_payment";
}

/** 待付款的账号数（侧边栏角标）。 */
export function pendingPayments(snapshot: Snapshot) {
  return snapshot.accounts.filter((a) => {
    if (a.pending) return false;
    const order = latestOrder(snapshot, a.id);
    return pendingPayment(order) && !paidSince(snapshot, a.id, order);
  }).length;
}

/**
 * 付款后查过订单就不再算"待付款"：官网订单列表用"我们正在等待你的付款"表示未付款，
 * 之后的订单状态会换成发货/送达时间，所以查过订单且不再等待就算已处理。
 */
export function paidSince(snapshot: Snapshot, accountId: string, order?: Task) {
  if (!order) return false;
  const latest = newest(
    snapshot.tasks.filter(
      (t) =>
        t.account_id === accountId &&
        t.action === "orders" &&
        t.status === "succeeded" &&
        t.updated_at > order.updated_at,
    ),
  )[0];
  if (!latest) return false;
  return !JSON.stringify(latest.result?.orders || []).includes("等待");
}

function latestOrder(snapshot: Snapshot, accountId: string) {
  return newest(
    snapshot.tasks.filter(
      (t) => t.account_id === accountId && ORDER_ACTIONS.includes(t.action),
    ),
  )[0];
}

function latestQr(snapshot: Snapshot, accountId: string, order?: Task) {
  const rows = newest(
    snapshot.tasks.filter(
      (t) => t.account_id === accountId && t.action === "qr",
    ),
  );
  // 只认比下单更新的二维码任务，避免旧订单的二维码盖住新订单。
  return rows.find(
    (t) => t.result?.qr_data && (!order || t.updated_at >= order.updated_at),
  );
}

function PaymentCard({
  account,
  order,
  qr,
  paid,
  busy,
  onStart,
  onOrders,
  onCancel,
}: {
  account: Account;
  order?: Task;
  qr?: Task;
  paid: boolean;
  busy: boolean;
  onStart: (accountId: string, action: Action, params?: Data) => void;
  onOrders: (accountId: string) => void;
  onCancel: (task: Task) => void;
}) {
  const { format } = useAccountPrivacy();
  const result = order?.result;
  const code = qr?.result?.qr_data || result?.qr_data;
  const codeError = qr?.result?.qr_error || result?.qr_error;
  const title = (
    <span className="pay-title">
      {format(account.name)}
      <small>{format(account.email)}</small>
    </span>
  );
  const fetching = Boolean(qr && active(qr));
  const state = !order
    ? "尚未下单"
    : paid
      ? "已查订单"
      : pendingPayment(order)
        ? "待付款"
        : stateNames[order.status] || order.status;
  return (
    <Card
      className={`pay-card ${order?.status || "idle"}`}
      title={title}
      extra={
        <Tag
          color={paid ? "green" : pendingPayment(order) ? "orange" : undefined}
        >
          {state}
        </Tag>
      }
    >
      {!order ? (
        <Typography.Paragraph type="secondary">
          还没有下单记录。到「批量下单」页提交一次，这里会显示付款二维码。
        </Typography.Paragraph>
      ) : active(order) ? (
        <div className="pay-progress" role="status">
          <Spin indicator={<LoaderCircle className="spin" />} />
          <div>
            <strong>{actionNames[order.action]}</strong>
            <p>{format(order.stage || stateNames[order.status])}</p>
          </div>
          <Button
            size="small"
            type="text"
            icon={<X />}
            onClick={() => onCancel(order)}
          >
            取消
          </Button>
        </div>
      ) : pendingPayment(order) ? (
        <div className="pay-body">
          <Typography.Paragraph className="pay-order">
            <QrCode aria-hidden /> 订单{" "}
            {result?.order_number || "请查询订单确认"}
            {result?.amount_due ? ` · ${result.amount_due}` : ""}
          </Typography.Paragraph>
          {Array.isArray(result?.applecare) && result.applecare.length > 0 && (
            <ul className="applecare-list" aria-label="已加入的 AppleCare+">
              {result.applecare.map((row: Data) => (
                <li key={String(row.sku || row.title)}>
                  <CheckCircle2 /> {String(row.title)}
                  {row.price ? ` · ${String(row.price)}` : ""}
                </li>
              ))}
            </ul>
          )}
          {code ? (
            <img
              className="pay-qr"
              src={code}
              alt={`订单 ${result?.order_number || ""} 的支付宝付款二维码`}
              width={200}
              height={200}
            />
          ) : (
            <Typography.Paragraph className="pay-hint">
              {format(codeError || "还没有取得二维码，可以重新获取。")}
            </Typography.Paragraph>
          )}
          {result?.message && (
            <Typography.Paragraph className="pay-hint">
              {format(String(result.message))}
            </Typography.Paragraph>
          )}
          {paid && (
            <Typography.Paragraph type="success">
              已查询过订单，官网不再显示等待付款。若确实还没付款，二维码仍可继续使用。
            </Typography.Paragraph>
          )}
          <Space wrap>
            {!code && (
              <Button
                type="primary"
                icon={fetching ? <LoaderCircle className="spin" /> : <QrCode />}
                disabled={busy || fetching}
                onClick={() =>
                  onStart(account.id, "qr", { source_task: order.id })
                }
              >
                获取二维码
              </Button>
            )}
            {code && (
              <Button
                icon={
                  fetching ? <LoaderCircle className="spin" /> : <RefreshCw />
                }
                disabled={busy || fetching}
                onClick={() =>
                  onStart(account.id, "qr", { source_task: order.id })
                }
              >
                换一张
              </Button>
            )}
            <Button disabled={busy} onClick={() => onOrders(account.id)}>
              我已支付，查询订单
            </Button>
          </Space>
          <Typography.Paragraph type="secondary">
            请用支付宝扫码支付。支付完成后点「我已支付，查询订单」确认状态。
          </Typography.Paragraph>
        </div>
      ) : (
        <div className="pay-body">
          <Typography.Paragraph className="pay-hint">
            {format(order.stage || result?.message || stateNames[order.status])}
          </Typography.Paragraph>
          {order.order_submitted && (
            <Typography.Paragraph type="secondary">
              订单可能已经提交到官网，请先查询订单再决定是否重新下单。
            </Typography.Paragraph>
          )}
          <Space wrap>
            <Button
              icon={<RefreshCw />}
              disabled={busy}
              onClick={() => onOrders(account.id)}
            >
              查询订单
            </Button>
            {order.status === "failed" &&
              ["purchase", "timed_purchase"].includes(order.action) && (
                <Button disabled={busy} onClick={() => onOrders(account.id)}>
                  确认结果
                </Button>
              )}
          </Space>
        </div>
      )}
    </Card>
  );
}

/** 付款码页：一个账号一张卡，二维码集中在这里，底部提示条只留日志与提示。 */
export function PaymentBoard({
  snapshot,
  busy,
  header,
  onStart,
  onOrders,
  onCancel,
}: {
  snapshot: Snapshot;
  busy: boolean;
  header?: ReactNode;
  onStart: (accountId: string, action: Action, params?: Data) => void;
  onOrders: (accountId: string) => void;
  onCancel: (task: Task) => void;
}) {
  const accounts = snapshot.accounts.filter((a) => !a.pending);
  const cards = accounts
    .map((account) => ({
      account,
      order: latestOrder(snapshot, account.id),
      qr: latestQr(snapshot, account.id, latestOrder(snapshot, account.id)),
    }))
    .filter((row) => row.order)
    .sort((a, b) => {
      const rank = (task?: Task) =>
        task &&
        pendingPayment(task) &&
        !paidSince(snapshot, task.account_id, task)
          ? 0
          : task && active(task)
            ? 1
            : task?.status === "succeeded"
              ? 2
              : 3;
      return rank(a.order) - rank(b.order);
    });
  const waiting = cards.filter(
    (row) =>
      pendingPayment(row.order) &&
      !paidSince(snapshot, row.account.id, row.order),
  ).length;
  return (
    <div className="pay-view">
      {header}
      <Section
        className="section"
        title="付款码"
        info={
          <>
            每个账号一张卡：下单成功后在这里显示支付宝付款二维码。
            底部提示条只显示进度与提示信息。
          </>
        }
      >
        <Typography.Paragraph type="secondary">
          {waiting
            ? `有 ${waiting} 个账号等待付款，请逐个扫码。`
            : "扫完码后点「我已支付，查询订单」确认订单状态。"}
        </Typography.Paragraph>
        {cards.length ? (
          <div className="pay-grid">
            {cards.map((row) => (
              <PaymentCard
                key={row.account.id}
                account={row.account}
                order={row.order}
                qr={row.qr}
                paid={paidSince(snapshot, row.account.id, row.order)}
                busy={busy}
                onStart={onStart}
                onOrders={onOrders}
                onCancel={onCancel}
              />
            ))}
          </div>
        ) : (
          <Typography.Paragraph type="secondary">
            还没有下单记录：到「账号工作台 ·
            批量下单」提交一次订单，付款二维码会集中显示在这里。
          </Typography.Paragraph>
        )}
      </Section>
    </div>
  );
}
