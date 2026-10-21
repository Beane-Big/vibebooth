import { useEffect, useState } from "react";
import { api, type App, type User } from "../api";

// 应用页列出能打开的应用；设置页只汇总各应用自己的设置页入口，设置内容由应用自己实现。
export default function Home({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [apps, setApps] = useState<App[] | null>(null);
  const [error, setError] = useState("");
  const isSettings = location.pathname === "/settings";

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

  const settingsApps = apps?.filter((app) => app.settingsUrl);
  const shown = isSettings ? settingsApps : apps;

  return (
    <>
      <header className="topbar">
        <span className="title">家庭应用门户</span>
        <nav className="tabs">
          <a className={isSettings ? "tab" : "tab active"} href="/">
            应用
          </a>
          {(isSettings || (settingsApps && settingsApps.length > 0)) && (
            <a className={isSettings ? "tab active" : "tab"} href="/settings">
              设置
            </a>
          )}
        </nav>
        <span className="spacer" />
        <span className="muted">{user.displayName}</span>
        <button className="link" onClick={logout}>
          退出
        </button>
      </header>
      <main className="content">
        {error && <p className="error">{error}</p>}
        {shown && shown.length === 0 && (
          <p className="muted">{isSettings ? "还没有可设置的组件。" : "还没有可用的应用。"}</p>
        )}
        <div className="grid">
          {shown?.map((app) => (
            <a key={app.id} className="card app" href={isSettings ? app.settingsUrl : app.url}>
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
                {isSettings ? (
                  <span className="muted">{app.name}的设置</span>
                ) : (
                  app.description && <span className="muted">{app.description}</span>
                )}
              </span>
            </a>
          ))}
        </div>
      </main>
    </>
  );
}
