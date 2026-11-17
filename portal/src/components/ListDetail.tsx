import type { ReactNode } from "react";
import { Button, Col, Flex, Grid, Row } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";

export default function ListDetail({ list, detail, selected, onBack, backLabel = "成员", listWidth }: {
  list: ReactNode;
  detail: ReactNode;
  selected: boolean;
  onBack: () => void;
  backLabel?: string;
  listWidth?: number;
}) {
  const wide = !!Grid.useBreakpoint().lg;
  if (wide) {
    return (
      <Row gutter={16} align="top" wrap={false}>
        <Col span={listWidth ? undefined : 8} flex={listWidth ? `0 0 ${listWidth}px` : undefined}>{list}</Col>
        <Col span={listWidth ? undefined : 16} flex={listWidth ? "1 1 0" : undefined} style={{ minWidth: 0 }}>{detail}</Col>
      </Row>
    );
  }
  return selected ? (
    <Flex vertical gap={12}>
      <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} style={{ alignSelf: "flex-start" }}>
        {backLabel}
      </Button>
      {detail}
    </Flex>
  ) : list;
}
