import { useEffect, useState } from "react";
import { api, ApiError, type User } from "./api";
import Login from "./pages/Login";
import Home from "./pages/Home";

// 门户只有登录、应用、设置三个页面，用路径区分即可，不引入路由库。
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

  if (loading) return <div className="center muted">加载中…</div>;

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
  return <Home user={user} onLogout={() => setUser(null)} />;
}
