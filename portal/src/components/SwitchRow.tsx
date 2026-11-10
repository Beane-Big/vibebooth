import type { ReactNode } from "react";
import { Flex, Switch, Typography } from "antd";

// SwitchRow 是一行开关：左边是名称和说明，右边是开关。账号设置、权限和统计的开关都用它。
export default function SwitchRow({
  title,
  description,
  checked,
  disabled,
  onChange,
  extra,
}: {
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  extra?: ReactNode;
}) {
  return (
    <Flex align="center" gap={12} className="switch-row">
      <Flex vertical style={{ flex: 1, minWidth: 0 }}>
        <Typography.Text>{title}</Typography.Text>
        {description && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {description}
          </Typography.Text>
        )}
      </Flex>
      {extra}
      <Switch checked={checked} disabled={disabled} onChange={onChange} />
    </Flex>
  );
}
