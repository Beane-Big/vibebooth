import { useEffect, useState } from "react";
import { Alert, Spin } from "antd";
import { api, ApiError, isAdmin, type App as AppInfo, type User } from "./api";
import { builtinApps, isBuiltinURL } from "./builtin";
import { AppFrames, AppTabBar, clearAppTabs, PORTAL_TAB, useAppTabs, type AppTab } from "./components/AppTabs";
import Layout, { type Tab } from "./components/Layout";
import Login from "./pages/Login";
import Home from "./pages/Home";
import Modules from "./pages/Modules";
import Users from "./pages/Users";

// 门户页面不多，用路径区分即可，不引入路由库。切换页面用 history.pushState，不整页刷新，已打开的应用标签不会重新加载。
const pages: Record<string, Tab> = {
  "/": "apps",
  "/settings": "settings",
  "/admin/modules": "modules",
  "/admin/users": "users",
};

const pageTitles: Record<Tab, string> = { apps: "应用", settings: "设置", modules: "应用管理", users: "用户" };

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

function Portal({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [error, setError] = useState("");
  const [path, setPath] = useState(location.pathname);
  const tabs = useAppTabs();
  let active = pages[path] ?? "apps";
  // 管理页只给管理员；其他人输入网址也只会看到应用页，接口本身也会拒绝。
  if ((active === "modules" || active === "users") && !isAdmin(user)) active = "apps";

  useEffect(() => {
    api
      .apps()
      .then(setApps)
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    const onPopState = () => setPath(location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // 打开门户的某个页面，同时切回门户标签。
  function navigate(to: string) {
    if (to !== location.pathname) history.pushState(null, "", to);
    setPath(to);
    tabs.activate(PORTAL_TAB);
  }

  // 应用的标签页里加载到了门户自己：登录过期时整页去登录，登录后回到门户并恢复标签；
  // 指向平台自带应用（例如家庭优化大师的“管理人员”）时，应用退回原来的页面，另开自带应用的标签；
  // 其他情况关掉这个标签，打开对应的门户页面。
  function onEmbeddedPortal(tab: AppTab, url: string, frame: HTMLIFrameElement) {
    if (url.startsWith("/login")) {
      location.href = "/login";
      return;
    }
    const path = url.split("?")[0];
    const builtin = builtinApps.find((app) => app.url === path);
    if (builtin) {
      frame.contentWindow?.history.back();
      tabs.open({ url: builtin.url, title: builtin.name });
      return;
    }
    tabs.close(tab.url);
    navigate(path);
  }

  return (
    <Layout
      user={user}
      active={active}
      showSettings={!!apps?.some((app) => app.settingsUrl)}
      onNavigate={navigate}
      onLogout={onLogout}
    >
      <AppTabBar state={tabs} portalTitle={pageTitles[active]} />
      <div className="content" style={tabs.active !== PORTAL_TAB ? { display: "none" } : undefined}>
        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
        {active === "modules" && <Modules />}
        {active === "users" && <Users me={user} />}
        {(active === "apps" || active === "settings") && apps && (
          <Home
            apps={apps}
            builtins={builtinApps.filter((app) => !app.adminOnly || isAdmin(user))}
            isSettings={active === "settings"}
            onOpen={tabs.open}
          />
        )}
      </div>
      {tabs.tabs
        .filter((t) => isBuiltinURL(t.url))
        .map((t) => (
          <div key={t.url} className="content" style={t.url !== tabs.active ? { display: "none" } : undefined}>
            {t.url === "/admin/users" && isAdmin(user) && <Users me={user} />}
          </div>
        ))}
      <AppFrames state={tabs} onEmbeddedPortal={onEmbeddedPortal} />
    </Layout>
  );
}
