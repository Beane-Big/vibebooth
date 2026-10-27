import { useState } from "react";
import { Card, Col, Empty, Menu, Row } from "antd";
import { AppstoreOutlined, SkinOutlined } from "@ant-design/icons";
import { hasPerm, type Me } from "../api";
import Modules from "./Modules";
import Themes from "./Themes";

// 平台自带的“设置”应用：左边是设置项，右边是选中项的内容。目前有“应用管理”和“主题”，都要有“应用管理”权限才显示，
// 没有的人看到空页面。
export default function Settings({ me }: { me: Me }) {
  const items = hasPerm(me, "modules")
    ? [
        { key: "modules", icon: <AppstoreOutlined />, label: "应用管理" },
        { key: "themes", icon: <SkinOutlined />, label: "主题" },
      ]
    : [];
  const [active, setActive] = useState(items[0]?.key ?? "");

  if (items.length === 0) return <Empty description="暂时没有系统设置。" />;
  return (
    <Row gutter={[16, 16]} align="top">
      <Col xs={24} lg={6}>
        <Card size="small" styles={{ body: { padding: 4 } }}>
          <Menu
            mode="inline"
            selectedKeys={[active]}
            items={items}
            onClick={(e) => setActive(e.key)}
            style={{ borderInlineEnd: 0, background: "transparent" }}
          />
        </Card>
      </Col>
      <Col xs={24} lg={18}>
        {active === "modules" && <Modules />}
        {active === "themes" && <Themes />}
      </Col>
    </Row>
  );
}
