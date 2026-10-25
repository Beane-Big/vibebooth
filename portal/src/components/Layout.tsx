import { cloneElement, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { Avatar, Button, Dropdown, Grid, Layout as AntLayout, Menu, Segmented, Tooltip, Typography, theme } from "antd";
import { AppstoreOutlined, HomeOutlined, LogoutOutlined, SettingOutlined, TeamOutlined } from "@ant-design/icons";
import { api, isAdmin, type User } from "../api";
import { useThemeMode, type ThemeMode } from "../theme";

export type Tab = "apps" | "settings" | "modules" | "users";

// 门户各页面共用的顶栏，children 放在顶栏下面。顶栏只放回到应用页的首页图标，设置、应用管理、用户收在点头像弹出的菜单里，
// “应用管理”和“用户”只对管理员显示。页面由 onNavigate 在门户内切换；按住 Ctrl / Cmd 或用中键点击时照常在新标签页打开。
export default function Layout({
  user,
  active,
  showSettings,
  onNavigate,
  onLogout,
  children,
}: {
  user: User;
  active: Tab;
  showSettings: boolean;
  onNavigate: (path: string) => void;
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

  const pages: { id: Tab; label: string; href: string; icon?: ReactNode; shown: boolean }[] = [
    { id: "apps", label: "应用", href: "/", shown: true },
    { id: "settings", label: "设置", href: "/settings", icon: <SettingOutlined />, shown: showSettings || active === "settings" },
    { id: "modules", label: "应用管理", href: "/admin/modules", icon: <AppstoreOutlined />, shown: isAdmin(user) },
    { id: "users", label: "用户", href: "/admin/users", icon: <TeamOutlined />, shown: isAdmin(user) },
  ];
  const link = (p: (typeof pages)[number], content: ReactNode = p.label) => (
    <a
      href={p.href}
      aria-label={p.label}
      onClick={(e) => {
        if (!inPlace(e)) return;
        e.preventDefault();
        onNavigate(p.href);
      }}
    >
      {content}
    </a>
  );
  const menuPages = pages.filter((p) => p.id !== "apps" && p.shown);

  return (
    <AntLayout style={{ minHeight: "100vh" }}>
      <AntLayout.Header className="topbar">
        <span className="brand">Vibebooth</span>
        <Menu
          mode="horizontal"
          selectedKeys={[active]}
          items={[
            {
              key: "apps",
              label: <Tooltip title="应用">{link(pages[0], <HomeOutlined style={{ fontSize: 18 }} />)}</Tooltip>,
            },
          ]}
        />
        <Dropdown
          trigger={["click"]}
          placement="bottomRight"
          menu={{
            selectedKeys: [active],
            items: [
              ...menuPages.map((p) => ({ key: p.id, icon: p.icon, label: link(p) })),
              ...(menuPages.length > 0 ? [{ type: "divider" as const }] : []),
              { key: "logout", icon: <LogoutOutlined />, label: "退出登录", onClick: logout },
            ],
          }}
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
      {children}
    </AntLayout>
  );
}

// inPlace 判断一次点击是不是普通的左键点击；按住修饰键或用中键时交给浏览器，在新标签页或新窗口打开。
export function inPlace(e: MouseEvent) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
