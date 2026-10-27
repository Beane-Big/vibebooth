import { cloneElement, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { Button, Dropdown, Grid, Layout as AntLayout, Segmented, Select, Typography, theme } from "antd";
import { IdcardOutlined, LogoutOutlined } from "@ant-design/icons";
import { api, type Me, type ThemeInfo } from "../api";
import PersonAvatar from "./PersonAvatar";
import { useThemeMode, type Skin, type ThemeMode } from "../theme";

// 门户各页面共用的顶栏，只有一行：左边是平台名称，中间是标签栏（第一个固定是首页），右边是头像。
// 用户、设置都是平台自带的应用，从首页打开（应用管理在设置里）；点头像可以切换外观和皮肤、打开“用户”应用看自己的资料和账号、退出登录。
// 皮肤除了内置的两种，还有管理员安装的主题包。onUserInfo 为空表示他不能用“用户”应用，菜单里就没有“用户信息”。
export default function Layout({
  user,
  tabs,
  onUserInfo,
  onLogout,
  themes,
  activeTheme,
  plain = false,
  children,
}: {
  user: Me;
  tabs: ReactNode;
  onUserInfo?: () => void;
  onLogout: () => void;
  // 已安装的主题包，和正在用的那个（没有时为空）。
  themes: ThemeInfo[];
  activeTheme?: string;
  // 页面底色用卡片的颜色，不用灰底。
  plain?: boolean;
  children: ReactNode;
}) {
  const { mode, setMode, skin, setSkin } = useThemeMode();
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
              <Typography.Text type="secondary" style={{ display: "block", padding: "0 8px 8px" }}>
                皮肤
              </Typography.Text>
              {themes.length === 0 ? (
                <Segmented<Skin> value={skin} onChange={setSkin} options={builtinSkins} style={{ margin: "0 4px 8px" }} />
              ) : (
                // 装了主题包以后选项多，换成下拉框；下拉列表放在菜单里面，选的时候菜单不会关掉。
                <Select<Skin>
                  value={activeTheme ? `theme:${activeTheme}` : skin.startsWith("theme:") ? "classic" : skin}
                  onChange={setSkin}
                  options={[...builtinSkins, ...themes.map((t) => ({ value: `theme:${t.id}` as Skin, label: t.name }))]}
                  getPopupContainer={(node) => node.parentElement!}
                  style={{ display: "block", margin: "0 4px 8px" }}
                />
              )}
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
      {children}
    </AntLayout>
  );
}

const builtinSkins: { value: Skin; label: string }[] = [
  { value: "classic", label: "经典" },
  { value: "tiles", label: "彩色方块" },
];

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
