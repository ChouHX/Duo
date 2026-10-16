import { useState } from "react";
import { Alert, Button, Modal, Space, Typography } from "antd";
import { Trash2 } from "lucide-react";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
    <Modal
      open
      title="移除本地账号"
      maskClosable={!busy}
      closable={!busy}
      confirmLoading={busy}
      onCancel={() => {
        if (!busy) onClose();
      }}
      footer={[
        <Button key="keep" autoFocus disabled={busy} onClick={onClose}>
          保留账号
        </Button>,
        <Button
          key="remove"
          danger
          type="primary"
          icon={<Trash2 />}
          loading={busy}
          onClick={remove}
        >
          {busy ? "正在移除" : "确认移除"}
        </Button>,
      ]}
    >
      <Typography.Paragraph>
        <Typography.Text strong>{format(account.name)}</Typography.Text>
        <br />
        <Typography.Text type="secondary">
          {format(account.email)}
        </Typography.Text>
      </Typography.Paragraph>
      <Typography.Paragraph>
        将清除这个账号在本机的登录会话、已保存密码、浏览器资料、地址与购买预设，以及本地订单和付款记录。之后可重新添加。
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary">
        不会注销 Apple 账号或取消官网订单，也不会修改其他账号和通用预设。
      </Typography.Paragraph>
      {error && (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Alert type="error" showIcon title={format(error)} />
        </Space>
      )}
    </Modal>
  );
}
