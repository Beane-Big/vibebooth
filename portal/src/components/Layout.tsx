import { cloneElement, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { App as AntApp, Button, Dropdown, Flex, Grid, Layout as AntLayout, Modal, Segmented, Typography, theme } from "antd";
import { CameraOutlined, LogoutOutlined } from "@ant-design/icons";
import { api, type Me } from "../api";
import { resizePhoto } from "../photo";
import PersonAvatar from "./PersonAvatar";
import { useThemeMode, type ThemeMode } from "../theme";

// 门户各页面共用的顶栏，只有一行：左边是平台名称，中间是标签栏（第一个固定是首页），右边是头像。
// 用户、设置都是平台自带的应用，从首页打开（应用管理在设置里）；点头像可以切换外观、换自己的头像和退出登录。
export default function Layout({
  user,
  tabs,
  onLogout,
  children,
}: {
  user: Me;
  tabs: ReactNode;
  onLogout: () => void;
  children: ReactNode;
}) {
  const { mode, setMode } = useThemeMode();
  // 手机上只显示头像，名字收进下拉菜单；平台名称也不显示，给标签栏腾地方。
  const screens = Grid.useBreakpoint();
  const { token } = theme.useToken();
  const [photo, setPhoto] = useState(user.photo);
  const [photoOpen, setPhotoOpen] = useState(false);

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
          menu={{
            items: [
              // 没关联成员的账号（比如客厅的平板）没有自己的头像。
              ...(user.personId !== null
                ? [{ key: "photo", icon: <CameraOutlined />, label: "更换头像", onClick: () => setPhotoOpen(true) }]
                : []),
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
            <PersonAvatar person={{ name: user.displayName, photo }} size={28} />
            {screens.sm && <span>{user.displayName}</span>}
          </Button>
        </Dropdown>
      </AntLayout.Header>
      {children}
      <Modal title="更换头像" open={photoOpen} footer={null} onCancel={() => setPhotoOpen(false)} width={360}>
        <MyPhoto name={user.displayName} photo={photo} onChange={setPhoto} />
      </Modal>
    </AntLayout>
  );
}

// MyPhoto 换自己的头像：选好照片立即保存，会自动裁成正方形。各个应用里看到的都是这张照片。
function MyPhoto({ name, photo, onChange }: { name: string; photo: string; onChange: (photo: string) => void }) {
  const { message } = AntApp.useApp();
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function save(next: () => Promise<string>, success: string) {
    setSaving(true);
    try {
      const res = await api.setMyPhoto(await next());
      onChange(res.photo);
      message.success(success);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Flex vertical align="center" gap={16} style={{ padding: "16px 0 8px" }}>
      <PersonAvatar person={{ name, photo }} size={96} />
      <Flex gap={8}>
        <Button type="primary" loading={saving} onClick={() => fileInput.current?.click()}>
          选择照片
        </Button>
        {photo && (
          <Button danger disabled={saving} onClick={() => save(async () => "", "已去掉头像")}>
            去掉照片
          </Button>
        )}
      </Flex>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) save(() => resizePhoto(file), "头像已更换");
        }}
      />
    </Flex>
  );
}

// inPlace 判断一次点击是不是普通的左键点击；按住修饰键或用中键时交给浏览器，在新标签页或新窗口打开。
export function inPlace(e: MouseEvent) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
