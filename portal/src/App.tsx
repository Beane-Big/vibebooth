import { useEffect, useState } from "react";
import { Alert, Button, Result, Spin } from "antd";
import { api, ApiError, type App as AppInfo, type Me } from "./api";
import { builtinAliases, builtinAppsFor, isBuiltinURL } from "./builtin";
import { AppFrames, AppTabBar, clearAppTabs, PORTAL_TAB, reloadFrame, useAppTabs, type AppTab } from "./components/AppTabs";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Home from "./pages/Home";
import Settings from "./pages/Settings";
import Users from "./pages/Users";

export default function App() {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

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
      <div className="center">
        <Spin />
      </div>
    );

  if (!user) {
    return <Login onLogin={(u) => {
      setUser(u);
      const next = new URLSearchParams(location.search).get("next");
      // 只允许跳回本站路径，防止被利用跳到外部网站。没有门户权限的人跳回门户也只会看到“没有权限”。
      if (next && next.startsWith("/") && !next.startsWith("//")) location.href = next;
      else history.replaceState(null, "", "/");
    }} />;
  }

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

// 门户只有首页一个页面，其余都在标签里：模块应用放在内嵌页，平台自带的应用（用户、设置）由门户直接渲染。
// 直接访问自带应用的网址（例如按住 Ctrl 点卡片）时打开它的标签，地址栏回到首页；旧网址 /admin/modules 打开“设置”。
function Portal({ user, onMeChanged, onLogout }: { user: Me; onMeChanged: () => void; onLogout: () => void }) {
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [error, setError] = useState("");
  const tabs = useAppTabs();
  // 每个标签被刷新的次数：平台自带的应用用它作 key 重新挂载，首页变了就重新取应用列表。
  const [reloads, setReloads] = useState<Record<string, number>>({});
  const builtins = builtinAppsFor(user);
  const findBuiltin = (path: string) => builtins.find((app) => app.url === (builtinAliases[path] ?? path));

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

  // 应用的标签页里加载到了门户自己：登录过期时整页去登录，登录后回到门户并恢复标签；
  // 指向平台自带应用（例如家庭优化大师空白时的“用户”链接）时，应用退回原来的页面，另开自带应用的标签；
  // 其他情况关掉这个标签，回到首页。
  function onEmbeddedPortal(tab: AppTab, url: string, frame: HTMLIFrameElement) {
    if (url.startsWith("/login")) {
      location.href = "/login";
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
  const usersApp = builtins.find((app) => app.id === "users");

  return (
    <Layout
      user={user}
      tabs={<AppTabBar state={tabs} onRefresh={refresh} />}
      onUserInfo={usersApp && (() => tabs.open({ url: usersApp.url, title: usersApp.name }))}
      onLogout={onLogout}
    >
      <div className="content" style={tabs.active !== PORTAL_TAB ? { display: "none" } : undefined}>
        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
        {apps && <Home apps={apps} builtins={builtins} onOpen={tabs.open} />}
      </div>
      {tabs.tabs
        .filter((t) => builtins.some((app) => app.url === t.url))
        .map((t) => (
          <div
            key={`${t.url}#${reloads[t.url] ?? 0}`}
            className="content"
            style={t.url !== tabs.active ? { display: "none" } : undefined}
          >
            {t.url === "/admin/users" && <Users me={user} onMeChanged={onMeChanged} />}
            {t.url === "/settings" && <Settings me={user} />}
          </div>
        ))}
      <AppFrames state={tabs} onEmbeddedPortal={onEmbeddedPortal} />
    </Layout>
  );
}
