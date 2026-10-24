import { useEffect, useState } from "react";
import { Alert, Spin } from "antd";
import { api, ApiError, isAdmin, type App as AppInfo, type User } from "./api";
import Layout, { type Tab } from "./components/Layout";
import Login from "./pages/Login";
import Home from "./pages/Home";
import Modules from "./pages/Modules";
import Users from "./pages/Users";

// 门户页面不多，用路径区分即可，不引入路由库。
const pages: Record<string, Tab> = {
  "/": "apps",
  "/settings": "settings",
  "/admin/modules": "modules",
  "/admin/users": "users",
};

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
  return <Portal user={user} onLogout={() => setUser(null)} />;
}

function Portal({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [error, setError] = useState("");
  let active = pages[location.pathname] ?? "apps";
  // 管理页只给管理员；其他人输入网址也只会看到应用页，接口本身也会拒绝。
  if ((active === "modules" || active === "users") && !isAdmin(user)) active = "apps";

  useEffect(() => {
    api
      .apps()
      .then(setApps)
      .catch((err) => setError(err.message));
  }, []);

  return (
    <Layout user={user} active={active} showSettings={!!apps?.some((app) => app.settingsUrl)} onLogout={onLogout}>
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
      {active === "modules" && <Modules />}
      {active === "users" && <Users me={user} />}
      {(active === "apps" || active === "settings") && apps && <Home apps={apps} isSettings={active === "settings"} />}
    </Layout>
  );
}
