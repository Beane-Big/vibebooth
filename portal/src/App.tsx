import { useEffect, useState } from "react";
import { Alert, Empty, Spin } from "antd";
import { api, ApiError, isAdmin, type App as AppInfo, type User } from "./api";
import { builtinApps, isBuiltinURL } from "./builtin";
import { AppFrames, AppTabBar, clearAppTabs, PORTAL_TAB, reloadFrame, useAppTabs, type AppTab } from "./components/AppTabs";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Home from "./pages/Home";
import Modules from "./pages/Modules";
import Users from "./pages/Users";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
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
      // 只允许跳回本站路径，防止被利用跳到外部网站。
      if (next && next.startsWith("/") && !next.startsWith("//")) location.href = next;
      else history.replaceState(null, "", "/");
    }} />;
  }

  if (location.pathname === "/login") history.replaceState(null, "", "/");
  return (
    <Portal
      user={user}
      onLogout={() => {
        clearAppTabs();
        setUser(null);
      }}
    />
  );
}

// 门户只有首页一个页面，其余都在标签里：模块应用放在内嵌页，平台自带的应用（用户、应用管理、设置）由门户直接渲染。
// 直接访问自带应用的网址（例如按住 Ctrl 点卡片）时打开它的标签，地址栏回到首页。
function Portal({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [error, setError] = useState("");
  const tabs = useAppTabs();
  // 每个标签被刷新的次数：平台自带的应用用它作 key 重新挂载，首页变了就重新取应用列表。
  const [reloads, setReloads] = useState<Record<string, number>>({});
  // 管理类的自带应用只给管理员；其他人输入网址也只会看到首页，接口本身也会拒绝。
  const builtins = builtinApps.filter((app) => !app.adminOnly || isAdmin(user));

  useEffect(() => {
    const builtin = builtins.find((app) => app.url === location.pathname);
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
    const builtin = builtins.find((app) => app.url === path);
    if (builtin) {
      frame.contentWindow?.history.back();
      tabs.open({ url: builtin.url, title: builtin.name });
      return;
    }
    tabs.close(tab.url);
    tabs.activate(PORTAL_TAB);
  }

  return (
    <Layout user={user} tabs={<AppTabBar state={tabs} onRefresh={refresh} />} onLogout={onLogout}>
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
            {t.url === "/admin/users" && <Users me={user} />}
            {t.url === "/admin/modules" && <Modules />}
            {t.url === "/settings" && <Empty description="暂时没有系统设置。" />}
          </div>
        ))}
      <AppFrames state={tabs} onEmbeddedPortal={onEmbeddedPortal} />
    </Layout>
  );
}
