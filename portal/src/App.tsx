import { useEffect, useState } from "react";
import { Alert, App as AntApp, Button, Card, Flex, Result, Spin } from "antd";
import { useActivityBeat } from "./activity";
import { api, ApiError, type App as AppInfo, type Me } from "./api";
import { builtinAliases, builtinAppsFor, isBuiltinURL } from "./builtin";
import { AppFrames, AppTabBar, clearAppTabs, PORTAL_TAB, reloadFrame, useAppTabs, type AppTab } from "./components/AppTabs";
import Beian from "./components/Beian";
import Layout from "./components/Layout";
import NotificationBell from "./components/NotificationBell";
import OnboardingGuide, { useOnboarding } from "./components/OnboardingGuide";
import Login from "./pages/AuthForm";
import Home from "./pages/Home";
import Settings from "./pages/Settings";
import AppManagement from "./pages/AppManagement";
import Stats from "./pages/Stats";
import Themes from "./pages/Themes";
import Contacts from "./pages/Contacts";
import { usePlatformDefaultsOnly, useThemeMode } from "./theme";
import { useActiveTheme } from "./themeHost";

export default function App() {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [loginConfirmed, setLoginConfirmed] = useState(() => new URLSearchParams(location.search).get("confirmed") === "1");

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch((err) => {
        if (!(err instanceof ApiError && err.status === 401)) console.error(err);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading)
    return (
      <div className="auth-shell auth-loading">
        <Spin />
      </div>
    );

  if (!user) return <PublicEntry loginConfirmed={loginConfirmed} setLoginConfirmed={setLoginConfirmed} onLogin={setUser} />;

  // 不能用门户的人（例如只给了一个应用的平板）打开门户时直接拒绝，不自动跳转；他只能直接打开自己能用的应用。
  if (!user.platform) {
    return (
      <div className="center">
        <Result
          status="403"
          title="没有使用门户的权限"
          subTitle="这个账号只能直接打开管理员给他开通的应用。"
          extra={<Button onClick={() => api.logout().finally(() => setUser(null))}>退出登录</Button>}
        />
        <Beian />
      </div>
    );
  }

  if (location.pathname === "/login") history.replaceState(null, "", "/");
  return (
    <Portal
      user={user}
      onMeChanged={() => api.me().then(setUser).catch(console.error)}
      onLogout={() => {
        clearAppTabs();
        setUser(null);
      }}
    />
  );
}

// 未登录入口统一加载平台默认外观；准备好之前不绘制页面，避免个人缓存或内置皮肤短暂闪现。
function PublicEntry({
  loginConfirmed,
  setLoginConfirmed,
  onLogin,
}: {
  loginConfirmed: boolean;
  setLoginConfirmed: (confirmed: boolean) => void;
  onLogin: (user: Me) => void;
}) {
  usePlatformDefaultsOnly();
  const theme = useActiveTheme({ platformOnly: true });
  if (!theme.ready) {
    return <div className="auth-shell auth-loading"><Spin /></div>;
  }

  const path = location.pathname;
  if (path !== "/login" && !isBuiltinURL(path) && !builtinAliases[path]) {
    return <GuestPortal theme={theme} />;
  }
  const needsLogin = path !== "/login" || new URLSearchParams(location.search).has("next");
  if (needsLogin && !loginConfirmed) {
    return <LoginPrompt theme={theme} onContinue={() => setLoginConfirmed(true)} />;
  }
  return <Login onLogin={(user) => {
    onLogin(user);
    const next = new URLSearchParams(location.search).get("next") ?? (path !== "/login" ? path : null);
    // 只允许跳回本站路径，防止被利用跳到外部网站。没有门户权限的人跳回门户也只会看到“没有权限”。
    if (next && /^\/(?![\/\\])[^\\\s]*$/.test(next)) location.href = next;
    else history.replaceState(null, "", "/");
  }} />;
}

function LoginPrompt({ theme, onContinue }: { theme: ReturnType<typeof useActiveTheme>; onContinue: () => void }) {
  return (
    <Layout user={null} tabs={null} onHome={() => location.assign("/")} onLogout={() => {}}
      activeTheme={theme.active?.id} TopbarBackground={theme.def?.TopbarBackground}>
      <Flex align="center" justify="center" style={{ minHeight: "min(65vh, 560px)", padding: 24 }}>
        <Card style={{ width: "100%", maxWidth: 440, textAlign: "center" }}>
          <Result status="info" title="此功能需要登录"
            subTitle="是否前往登录或注册？"
            extra={[
              <Button key="cancel" onClick={() => location.assign("/")}>暂不登录</Button>,
              <Button key="continue" type="primary" onClick={onContinue}>登录或注册</Button>,
            ]} />
        </Card>
      </Flex>
      <Beian />
    </Layout>
  );
}

function GuestPortal({ theme }: { theme: ReturnType<typeof useActiveTheme> }) {
  const { modal } = AntApp.useApp();
  const { skin, wallpaper } = useThemeMode();
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [error, setError] = useState("");
  const tabs = useAppTabs();
  useEffect(() => {
    api.apps().then(setApps).catch((err) => setError(err.message));
  }, []);

  function openApp(tab: AppTab) {
    if (apps?.find((app) => app.url === tab.url)?.loginRequired) {
      modal.confirm({
        icon: null,
        centered: true,
        className: "login-confirm",
        title: "此功能需要登录",
        content: "是否前往登录或注册？",
        okText: "登录或注册",
        cancelText: "暂不登录",
        onOk: () => { location.href = "/login?next=%2F&confirmed=1"; },
      });
      return;
    }
    tabs.open(tab);
  }

  const availableTabs = tabs.tabs.filter((tab) => apps?.some((app) => app.url === tab.url && !app.loginRequired));
  const guestTabs = {
    ...tabs,
    tabs: availableTabs,
    active: availableTabs.some((tab) => tab.url === tabs.active) ? tabs.active : PORTAL_TAB,
  };

  function onEmbeddedPortal(tab: AppTab, url: string) {
    if (url.startsWith("/login")) {
      modal.confirm({
        icon: null,
        centered: true,
        className: "login-confirm",
        title: "此功能需要登录",
        content: "是否前往登录或注册？",
        okText: "登录或注册",
        cancelText: "暂不登录",
        onOk: () => { location.href = "/login?next=%2F&confirmed=1"; },
        onCancel: () => { tabs.close(tab.url); },
      });
    } else {
      tabs.close(tab.url);
      tabs.activate(PORTAL_TAB);
    }
  }

  return (
    <Layout user={null}
      tabs={<AppTabBar state={guestTabs} onRefresh={(key) => key === PORTAL_TAB ? location.reload() : reloadFrame(key)} />}
      onHome={() => tabs.activate(PORTAL_TAB)} onLogout={() => {}}
      activeTheme={theme.active?.id} TopbarBackground={theme.def?.TopbarBackground}
      plain={skin === "tiles" && guestTabs.active === PORTAL_TAB && !wallpaper}>
      <div className="content" style={guestTabs.active !== PORTAL_TAB ? { display: "none" } : undefined}>
        {error ? <Alert type="error" message={error} showIcon />
          : apps ? <Home apps={apps} builtins={[]} user={null} theme={theme.active && theme} onOpen={openApp} />
          : <Spin />}
      </div>
      <AppFrames state={guestTabs} onEmbeddedPortal={onEmbeddedPortal} />
      {guestTabs.active === PORTAL_TAB && <Beian />}
    </Layout>
  );
}

// 门户只有首页一个页面，其余都在标签里：模块应用放在内嵌页，平台自带的应用（用户、设置）由门户直接渲染。
// 直接访问自带应用的网址（例如按住 Ctrl 点卡片）时打开它的标签，地址栏回到首页；旧网址 /admin/modules 打开“设置”。
function Portal({ user, onMeChanged, onLogout }: { user: Me; onMeChanged: () => void; onLogout: () => void }) {
  const { modal } = AntApp.useApp();
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [error, setError] = useState("");
  const tabs = useAppTabs();
  const { skin, wallpaper } = useThemeMode();
  const theme = useActiveTheme();
  // 每个标签被刷新的次数：平台自带的应用用它作 key 重新挂载，首页变了就重新取应用列表。
  const [reloads, setReloads] = useState<Record<string, number>>({});
  const [entryPath, setEntryPath] = useState(() => location.pathname);
  const onboarding = useOnboarding(user.id);
  const builtins = builtinAppsFor(user);
  const findBuiltin = (path: string) => builtins.find((app) => app.url === (builtinAliases[path] ?? path));
  useActivityBeat(tabs.active);

  useEffect(() => {
    const builtin = findBuiltin(location.pathname);
    if (builtin) tabs.open({ url: builtin.url, title: builtin.name });
    if (location.pathname !== "/") history.replaceState(null, "", "/");
  }, []);

  useEffect(() => {
    setError("");
    api
      .apps()
      .then(setApps)
      .catch((err) => setError(err.message));
  }, [reloads[PORTAL_TAB]]);

  // 刷新一个标签：模块应用重新加载内嵌页，停在原来的页面；自带应用重新挂载、重新取数据；首页重新取应用列表。
  function refresh(key: string) {
    if (key !== PORTAL_TAB && !isBuiltinURL(key)) reloadFrame(key);
    else setReloads((r) => ({ ...r, [key]: (r[key] ?? 0) + 1 }));
  }

  function openHomeTab(tab: AppTab) {
    if (tab.url === "/applications" || tab.url === "/contacts") {
      setEntryPath(tab.url);
    }
    tabs.open(tab);
  }

  function openLink(link: string) {
    const path = link.split("?")[0];
    const builtin = findBuiltin(path);
    if (builtin) {
      setEntryPath(path);
      tabs.open({ url: builtin.url, title: builtin.name });
      return;
    }
    const matched = apps?.find((app) => link.startsWith(app.url));
    tabs.open({ url: link, title: matched?.name ?? path });
  }

  // 应用的标签页里加载到了门户自己：登录过期时整页去登录，登录后回到门户并恢复标签；
  // 指向平台自带应用（例如家庭优化大师空白时的“用户”链接）时，应用退回原来的页面，另开自带应用的标签；
  // 其他情况关掉这个标签，回到首页。
  function onEmbeddedPortal(tab: AppTab, url: string, frame: HTMLIFrameElement) {
    if (url.startsWith("/login")) {
      const target = "/login?next=%2F";
      modal.confirm({
        icon: null,
        centered: true,
        className: "login-confirm",
        title: "此功能需要登录",
        content: "是否前往登录或注册？",
        okText: "登录或注册",
        cancelText: "暂不登录",
        onOk: () => { location.href = target + "&confirmed=1"; },
        onCancel: () => { tabs.close(tab.url); },
      });
      return;
    }
    const path = url.split("?")[0];
    const builtin = findBuiltin(path);
    if (builtin) {
      frame.contentWindow?.history.back();
      tabs.open({ url: builtin.url, title: builtin.name });
      return;
    }
    tabs.close(tab.url);
    tabs.activate(PORTAL_TAB);
  }

  // 头像菜单里的“用户信息”打开“用户”应用，自己排在第一个；没有“用户”应用的人没有这一项。
  const usersApp = builtins.find((app) => app.id === "contacts");
  // 备案号放在首页和自带应用的底部；模块应用的内嵌页占满顶栏下面的区域，不放。
  const frameActive = tabs.active !== PORTAL_TAB && !isBuiltinURL(tabs.active);

  return (
    <Layout
      user={user}
      tabs={<AppTabBar state={tabs} onRefresh={refresh} />}
      notifications={<NotificationBell onNavigate={openLink} />}
      onHome={() => tabs.activate(PORTAL_TAB)}
      onUserInfo={usersApp && (() => openLink("/contacts/self"))}
      onShowGuide={() => {
        onboarding.reopen();
        tabs.activate(PORTAL_TAB);
      }}
      onLogout={onLogout}
      activeTheme={theme.active?.id}
      TopbarBackground={theme.def?.TopbarBackground}
      // 彩色方块皮肤的首页用卡片的底色（浅色时是纯白），彩色图标更干净；其他页面的卡片还是放在灰底上。选了壁纸时露出壁纸。
      plain={skin === "tiles" && tabs.active === PORTAL_TAB && !wallpaper}
    >
      <div className="content" style={tabs.active !== PORTAL_TAB ? { display: "none" } : undefined}>
        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
        {apps && !onboarding.state.dismissed && (
          <OnboardingGuide
            user={user}
            hasModules={apps.length > 0}
            doneIds={onboarding.state.done}
            onNavigate={openLink}
            onMarkDone={onboarding.markDone}
            onToggleDone={onboarding.toggleDone}
            onDismiss={onboarding.dismiss}
          />
        )}
        {apps && (
          <Home apps={apps} builtins={builtins} user={user} theme={theme.active && theme} onOpen={openHomeTab} />
        )}
      </div>
      {tabs.tabs
        .filter((t) => builtins.some((app) => !app.embedded && app.url === t.url))
        .map((t) => (
          <div
            key={`${t.url}#${reloads[t.url] ?? 0}`}
            className="content"
            style={t.url !== tabs.active ? { display: "none" } : undefined}
          >
            {t.url === "/contacts" && <Contacts me={user} onMeChanged={onMeChanged} entryPath={entryPath} />}
            {t.url === "/applications" && (
              <AppManagement me={user} entryPath={entryPath} hasModules={(apps?.length ?? 0) > 0} />
            )}
            {t.url === "/settings" && <Settings me={user} />}
            {t.url === "/themes" && <Themes me={user} themes={theme.themes} />}
            {t.url === "/stats" && <Stats onChanged={onMeChanged} />}
          </div>
        ))}
      <AppFrames state={tabs} onEmbeddedPortal={onEmbeddedPortal} />
      {!frameActive && <Beian />}
    </Layout>
  );
}
