import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Trash2 } from "lucide-react";
import { useAccountPrivacy } from "./AccountPrivacy";
import type { Account } from "./types";

export function RemoveAccountDialog({
  account,
  onRemove,
  onClose,
}: {
  account: Account;
  onRemove: () => Promise<void>;
  onClose: () => void;
}) {
  const { format } = useAccountPrivacy();
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await onRemove();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
  return (
    <dialog
      className="remove-account-dialog"
      ref={dialog}
      aria-labelledby="remove-account-title"
      aria-describedby="remove-account-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id="remove-account-title">移除本地账号</h2>
      <p className="remove-account-identity">
        <strong>{format(account.name)}</strong>
        <span>{format(account.email)}</span>
      </p>
      <p id="remove-account-description">
        将清除这个账号在本机的登录会话、已保存密码、浏览器资料、地址与购买预设，以及本地订单和付款记录。之后可重新添加。
      </p>
      <p className="muted">
        不会注销 Apple 账号或取消官网订单，也不会修改其他账号和通用预设。
      </p>
      {error && (
        <p role="alert" className="error-text">
          {format(error)}
        </p>
      )}
      <div className="button-row">
        <button autoFocus disabled={busy} onClick={onClose}>
          保留账号
        </button>
        <button className="danger-button" disabled={busy} onClick={remove}>
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Trash2 size={15} />
          )}
          {busy ? "正在移除" : "确认移除"}
        </button>
      </div>
    </dialog>
  );
}
