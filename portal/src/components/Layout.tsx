import { cloneElement, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { Button, Dropdown, Grid, Layout as AntLayout, Segmented, Typography, theme } from "antd";
import { IdcardOutlined, LogoutOutlined } from "@ant-design/icons";
import { api, type Me } from "../api";
import PersonAvatar from "./PersonAvatar";
import { useThemeMode, type Skin, type ThemeMode } from "../theme";

// 门户各页面共用的顶栏，只有一行：左边是平台名称，中间是标签栏（第一个固定是首页），右边是头像。
// 用户、设置、主题都是平台自带的应用，从首页打开（应用管理在设置里，皮肤在主题里选）；点头像可以切换浅色深色、打开“用户”应用看自己的资料和账号、退出登录。
// onUserInfo 为空表示他不能用“用户”应用，菜单里就没有“用户信息”。
export default function Layout({
  user,
  tabs,
  onUserInfo,
  onLogout,
  activeTheme,
  plain = false,
  children,
}: {
  user: Me;
  tabs: ReactNode;
  onUserInfo?: () => void;
  onLogout: () => void;
  // 正在用的主题包（没有时为空）。
  activeTheme?: string;
  // 页面底色用卡片的颜色，不用灰底。
  plain?: boolean;
  children: ReactNode;
}) {
  const { mode, setMode, skin } = useThemeMode();
  // 手机上只显示头像，名字收进下拉菜单；平台名称也不显示，给标签栏腾地方。
  const screens = Grid.useBreakpoint();
  const { token } = theme.useToken();

  async function logout() {
    await api.logout();
    onLogout();
  }

  return (
    <AntLayout className={skinClass(skin, activeTheme)} style={{ minHeight: "100vh", background: plain ? "var(--surface)" : undefined }}>
      <AntLayout.Header className="topbar">
        {screens.sm && <span className="brand">Vibebooth</span>}
        {tabs}
        <Dropdown
          trigger={["click"]}
          placement="bottomRight"
          menu={{
            items: [
              ...(onUserInfo ? [{ key: "user", icon: <IdcardOutlined />, label: "用户信息", onClick: onUserInfo }] : []),
              { key: "logout", icon: <LogoutOutlined />, label: "退出登录", onClick: logout },
            ],
          }}
          dropdownRender={(menu) => (
            <div
              className="vb-popup"
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
            <PersonAvatar person={{ name: user.displayName, photo: user.photo }} size={28} />
            {screens.sm && <span>{user.displayName}</span>}
          </Button>
        </Dropdown>
      </AntLayout.Header>
      <div className="layout-content">{children}</div>
    </AntLayout>
  );
}

// skinClass 是顶层的 class：内置皮肤是 skin-classic / skin-tiles，主题包是 skin-theme theme-<id>，主题的样式表可以据此写规则。
// 选用的主题被卸载了按经典皮肤显示。
function skinClass(skin: Skin, activeTheme?: string) {
  if (activeTheme) return `skin-theme theme-${activeTheme}`;
  return skin.startsWith("theme:") ? "skin-classic" : `skin-${skin}`;
}

// inPlace 判断一次点击是不是普通的左键点击；按住修饰键或用中键时交给浏览器，在新标签页或新窗口打开。
export function inPlace(e: MouseEvent) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
