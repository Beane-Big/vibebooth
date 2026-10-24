import { cloneElement, type ReactElement, type ReactNode } from "react";
import { Avatar, Button, Dropdown, Grid, Layout as AntLayout, Menu, Segmented, Typography, theme } from "antd";
import { LogoutOutlined } from "@ant-design/icons";
import { api, isAdmin, type User } from "../api";
import { useThemeMode, type ThemeMode } from "../theme";

export type Tab = "apps" | "settings" | "modules" | "users";

// 门户各页面共用的顶栏和内容区。“应用管理”和“用户”只对管理员显示。
export default function Layout({
  user,
  active,
  showSettings,
  onLogout,
  children,
}: {
  user: User;
  active: Tab;
  showSettings: boolean;
  onLogout: () => void;
  children: ReactNode;
}) {
  const { mode, setMode } = useThemeMode();
  // 手机上只显示头像，名字收进下拉菜单。
  const screens = Grid.useBreakpoint();
  const { token } = theme.useToken();

  async function logout() {
    await api.logout();
    onLogout();
  }

  const tabs: { id: Tab; label: string; href: string; shown: boolean }[] = [
    { id: "apps", label: "应用", href: "/", shown: true },
    { id: "settings", label: "设置", href: "/settings", shown: showSettings || active === "settings" },
    { id: "modules", label: "应用管理", href: "/admin/modules", shown: isAdmin(user) },
    { id: "users", label: "用户", href: "/admin/users", shown: isAdmin(user) },
  ];

  return (
    <AntLayout style={{ minHeight: "100vh" }}>
      <AntLayout.Header className="topbar">
        <span className="brand">Vibebooth</span>
        <Menu
          mode="horizontal"
          selectedKeys={[active]}
          items={tabs.filter((t) => t.shown).map((t) => ({ key: t.id, label: <a href={t.href}>{t.label}</a> }))}
        />
        <Dropdown
          trigger={["click"]}
          placement="bottomRight"
          menu={{ items: [{ key: "logout", icon: <LogoutOutlined />, label: "退出登录", onClick: logout }] }}
          dropdownRender={(menu) => (
            <div
              style={{
                padding: 8,
                minWidth: 260,
                background: token.colorBgElevated,
                borderRadius: token.borderRadiusLG,
                boxShadow: token.boxShadowSecondary,
              }}
            >
              <Typography.Text strong style={{ display: "block", padding: "4px 8px" }}>
                {user.displayName}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ display: "block", padding: "0 8px 8px" }}>
                外观
              </Typography.Text>
              <Segmented<ThemeMode>
                value={mode}
                onChange={setMode}
                options={[
                  { value: "light", label: "浅色" },
                  { value: "dark", label: "深色" },
                  { value: "system", label: "跟随系统" },
                ]}
                style={{ margin: "0 4px 8px" }}
              />
              {cloneElement(menu as ReactElement<{ style?: object }>, { style: { boxShadow: "none", padding: 0 } })}
            </div>
          )}
        >
          <Button type="text" style={{ paddingInline: 8, height: 40 }}>
            <Avatar size={28} style={{ backgroundColor: "var(--accent)" }}>
              {user.displayName.slice(0, 1)}
            </Avatar>
            {screens.sm && <span>{user.displayName}</span>}
          </Button>
        </Dropdown>
      </AntLayout.Header>
      <AntLayout.Content className="content">{children}</AntLayout.Content>
    </AntLayout>
  );
}
