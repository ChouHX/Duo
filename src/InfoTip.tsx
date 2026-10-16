import type { ReactNode } from "react";
import { Tooltip } from "antd";
import { Info } from "lucide-react";

// 说明性文字收进小图标，悬停（或键盘聚焦）才展开，界面默认保持干净。
export function InfoTip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Tooltip title={children} placement="bottomLeft">
      <button type="button" className="info-tip" aria-label={label}>
        <Info aria-hidden />
      </button>
    </Tooltip>
  );
}
