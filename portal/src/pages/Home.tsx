import { useEffect, useState } from "react";
import { api, type App, type User } from "../api";

export default function Home({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [apps, setApps] = useState<App[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .apps()
      .then(setApps)
      .catch((err) => setError(err.message));
  }, []);

  async function logout() {
    await api.logout();
    onLogout();
  }

  return (
    <>
      <header className="topbar">
        <span className="title">家庭应用门户</span>
        <span className="spacer" />
        <span className="muted">{user.displayName}</span>
        <button className="link" onClick={logout}>
          退出
        </button>
      </header>
      <main className="content">
        {error && <p className="error">{error}</p>}
        {apps && apps.length === 0 && <p className="muted">还没有可用的应用。</p>}
        <div className="grid">
          {apps?.map((app) => (
            <a key={app.id} className="card app" href={app.url}>
              {app.icon ? (
                <img className="icon" src={app.icon} alt="" />
              ) : (
                <span className="icon placeholder">{app.name.slice(0, 1)}</span>
              )}
              <span className="app-text">
                <span className="app-name">
                  {app.name}
                  {!app.healthy && <span className="badge">不可用</span>}
                </span>
                {app.description && <span className="muted">{app.description}</span>}
              </span>
            </a>
          ))}
        </div>
      </main>
    </>
  );
}
