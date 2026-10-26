import { cloneElement, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { Avatar, Button, Dropdown, Grid, Layout as AntLayout, Segmented, Typography, theme } from "antd";
import { LogoutOutlined } from "@ant-design/icons";
import { api, type User } from "../api";
import { useThemeMode, type ThemeMode } from "../theme";

// 门户各页面共用的顶栏，只有一行：左边是平台名称，中间是标签栏（第一个固定是首页），右边是头像。
// 用户、设置都是平台自带的应用，从首页打开（应用管理在设置里）；点头像只能切换外观和退出登录。
export default function Layout({
  user,
  tabs,
  onLogout,
  children,
}: {
  user: User;
  tabs: ReactNode;
  onLogout: () => void;
  children: ReactNode;
}) {
  const { mode, setMode } = useThemeMode();
  // 手机上只显示头像，名字收进下拉菜单；平台名称也不显示，给标签栏腾地方。
  const screens = Grid.useBreakpoint();
  const { token } = theme.useToken();

  async function logout() {
    await api.logout();
    onLogout();
  }

  return (
    <AntLayout style={{ minHeight: "100vh" }}>
      <AntLayout.Header className="topbar">
        {screens.sm && <span className="brand">Vibebooth</span>}
        {tabs}
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
      {children}
    </AntLayout>
  );
}

// inPlace 判断一次点击是不是普通的左键点击；按住修饰键或用中键时交给浏览器，在新标签页或新窗口打开。
export function inPlace(e: MouseEvent) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
