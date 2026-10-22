import type { App } from "../api";

// 应用页列出能打开的应用；设置页只汇总各应用自己的设置页入口，设置内容由应用自己实现。
export default function Home({ apps, isSettings }: { apps: App[]; isSettings: boolean }) {
  const shown = isSettings ? apps.filter((app) => app.settingsUrl) : apps;

  return (
    <>
      {shown.length === 0 && (
        <p className="muted">{isSettings ? "还没有可设置的组件。" : "还没有可用的应用。"}</p>
      )}
      <div className="grid">
        {shown.map((app) => (
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
    </>
  );
}
