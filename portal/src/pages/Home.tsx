import { Card, Col, Empty, Row, Tag, Typography } from "antd";
import type { App } from "../api";
import type { AppTab } from "../components/AppTabs";
import { inPlace } from "../components/Layout";

// 应用页列出能打开的应用；设置页只汇总各应用自己的设置页入口，设置内容由应用自己实现。
// 点卡片在门户里以标签页打开；按住 Ctrl / Cmd 或用中键点击时在浏览器新标签页打开，登录状态共享。
export default function Home({
  apps,
  isSettings,
  onOpen,
}: {
  apps: App[];
  isSettings: boolean;
  onOpen: (tab: AppTab) => void;
}) {
  const shown = isSettings ? apps.filter((app) => app.settingsUrl) : apps;

  if (shown.length === 0) {
    return <Empty description={isSettings ? "还没有可设置的组件。" : "还没有可用的应用。"} />;
  }
  return (
    <Row gutter={[16, 16]}>
      {shown.map((app) => (
        <Col key={app.id} xs={24} sm={12} lg={8} xxl={6}>
          <a
            href={isSettings ? app.settingsUrl : app.url}
            onClick={(e) => {
              if (!inPlace(e)) return;
              e.preventDefault();
              onOpen(
                isSettings
                  ? { url: app.settingsUrl!, title: `${app.name} · 设置` }
                  : { url: app.url, title: app.name },
              );
            }}
          >
            <Card hoverable size="small" styles={{ body: { padding: 16 } }}>
              <div className="app-card">
                {app.icon ? (
                  <img className="app-icon" src={app.icon} alt="" />
                ) : (
                  <AppPlaceholder name={app.name} />
                )}
                <div className="app-text">
                  <Typography.Text strong ellipsis>
                    {app.name}
                    {!app.healthy && (
                      <Tag color="error" style={{ marginInlineStart: 8 }}>
                        不可用
                      </Tag>
                    )}
                  </Typography.Text>
                  <Typography.Text type="secondary" ellipsis>
                    {isSettings ? `${app.name}的设置` : app.description || " "}
                  </Typography.Text>
                </div>
              </div>
            </Card>
          </a>
        </Col>
      ))}
    </Row>
  );
}

// 应用没有图标时用名称的第一个字。
function AppPlaceholder({ name }: { name: string }) {
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
      {name.slice(0, 1)}
    </span>
  );
}
