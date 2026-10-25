import type { ReactNode } from "react";
import { Card, Col, Empty, Row, Tag, Typography } from "antd";
import type { App } from "../api";
import type { BuiltinApp } from "../builtin";
import type { AppTab } from "../components/AppTabs";
import { inPlace } from "../components/Layout";

// 应用页列出能打开的应用，平台自带的应用排在前面；设置页只汇总各应用自己的设置页入口，设置内容由应用自己实现。
// 点卡片在门户里以标签页打开；按住 Ctrl / Cmd 或用中键点击时在浏览器新标签页打开，登录状态共享。
export default function Home({
  apps,
  builtins,
  isSettings,
  onOpen,
}: {
  apps: App[];
  builtins: BuiltinApp[];
  isSettings: boolean;
  onOpen: (tab: AppTab) => void;
}) {
  const shown = isSettings ? apps.filter((app) => app.settingsUrl) : apps;

  if (shown.length === 0 && (isSettings || builtins.length === 0)) {
    return <Empty description={isSettings ? "还没有可设置的组件。" : "还没有可用的应用。"} />;
  }
  return (
    <Row gutter={[16, 16]}>
      {!isSettings &&
        builtins.map((app) => (
          <AppCard
            key={app.id}
            tab={{ url: app.url, title: app.name }}
            icon={<IconBox>{app.icon}</IconBox>}
            description={app.description}
            onOpen={onOpen}
          />
        ))}
      {shown.map((app) => (
        <AppCard
          key={app.id}
          tab={isSettings ? { url: app.settingsUrl!, title: `${app.name} · 设置` } : { url: app.url, title: app.name }}
          name={app.name}
          icon={app.icon ? <img className="app-icon" src={app.icon} alt="" /> : <IconBox>{app.name.slice(0, 1)}</IconBox>}
          description={isSettings ? `${app.name}的设置` : app.description || " "}
          unhealthy={!app.healthy}
          onOpen={onOpen}
        />
      ))}
    </Row>
  );
}

// AppCard 是一张应用卡片，点击在门户里以标签页打开；name 不填时用标签标题。
function AppCard({
  tab,
  name = tab.title,
  icon,
  description,
  unhealthy = false,
  onOpen,
}: {
  tab: AppTab;
  name?: string;
  icon: ReactNode;
  description: string;
  unhealthy?: boolean;
  onOpen: (tab: AppTab) => void;
}) {
  return (
    <Col xs={24} sm={12} lg={8} xxl={6}>
      <a
        href={tab.url}
        onClick={(e) => {
          if (!inPlace(e)) return;
          e.preventDefault();
          onOpen(tab);
        }}
      >
        <Card hoverable size="small" styles={{ body: { padding: 16 } }}>
          <div className="app-card">
            {icon}
            <div className="app-text">
              <Typography.Text strong ellipsis>
                {name}
                {unhealthy && (
                  <Tag color="error" style={{ marginInlineStart: 8 }}>
                    不可用
                  </Tag>
                )}
              </Typography.Text>
              <Typography.Text type="secondary" ellipsis>
                {description}
              </Typography.Text>
            </div>
          </div>
        </Card>
      </a>
    </Col>
  );
}

// 没有图片图标的应用：模块用名称的第一个字，平台自带的应用用图标。
function IconBox({ children }: { children: ReactNode }) {
  return (
    <span
      className="app-icon"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        color: "var(--accent)",
        fontSize: 20,
        fontWeight: 600,
      }}
    >
      {children}
    </span>
  );
}
