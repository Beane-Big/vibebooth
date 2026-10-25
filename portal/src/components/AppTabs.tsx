import { useEffect, useRef, useState } from "react";
import { Button, Tabs, Tooltip } from "antd";
import { ExportOutlined } from "@ant-design/icons";

// 在门户里打开的应用：每个应用一个标签页，内容是同一个网站下的内嵌页，登录状态天然共享。
// 打开的标签记在 sessionStorage 里，刷新页面后恢复；关掉浏览器标签页就清空。

export type AppTab = { url: string; title: string };

// 第一个标签固定是门户自己（应用、设置、应用管理、用户这些页面）。
export const PORTAL_TAB = "portal";

// 门户被加载进了自己的内嵌页时（应用的“返回”链接、登录过期跳到登录页），内嵌页里的门户发出这个事件交给外层处理，见 main.tsx。
export const EMBEDDED_EVENT = "vb-portal-embedded";
export type EmbeddedDetail = { frame: Element | null; url: string };

const storageKey = "vb-tabs";

type Saved = { tabs: AppTab[]; active: string };

function load(): Saved {
  try {
    const v = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    const tabs: AppTab[] = Array.isArray(v?.tabs)
      ? v.tabs.filter((t: AppTab) => typeof t?.url === "string" && t.url.startsWith("/apps/") && typeof t.title === "string")
      : [];
    const active = tabs.some((t) => t.url === v?.active) ? v.active : PORTAL_TAB;
    return { tabs, active };
  } catch {
    // 浏览器禁用了存储时不恢复，这次打开页面内照常可用。
    return { tabs: [], active: PORTAL_TAB };
  }
}

// clearAppTabs 在退出登录时清掉记下的标签，换个人登录不会看到上一个人打开的应用。
export function clearAppTabs() {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // 同上。
  }
}

// currentURL 返回标签里应用现在所在的页面，应用里点到别的页面后，“在新窗口打开”打开的也是那一页。
function currentURL(tab: AppTab) {
  const frame = document.querySelector<HTMLIFrameElement>(`.app-frames iframe[data-url="${CSS.escape(tab.url)}"]`);
  try {
    const loc = frame?.contentWindow?.location;
    if (loc?.pathname.startsWith("/apps/")) return loc.pathname + loc.search + loc.hash;
  } catch {
    // 拿不到时用打开时的网址。
  }
  return tab.url;
}

export function useAppTabs() {
  const [saved, setSaved] = useState(load);

  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(saved));
    } catch {
      // 存不下也没关系。
    }
  }, [saved]);

  // 同一个网址只开一个标签，再点就切过去。
  function open(tab: AppTab) {
    setSaved((s) => ({ tabs: s.tabs.some((t) => t.url === tab.url) ? s.tabs : [...s.tabs, tab], active: tab.url }));
  }

  // 关掉当前标签时切到它左边的那个，没有就回到门户。
  function close(url: string) {
    setSaved((s) => {
      const i = s.tabs.findIndex((t) => t.url === url);
      const tabs = s.tabs.filter((t) => t.url !== url);
      const active = s.active !== url ? s.active : (tabs[i - 1]?.url ?? PORTAL_TAB);
      return { tabs, active };
    });
  }

  function activate(key: string) {
    setSaved((s) => ({ ...s, active: key }));
  }

  return { tabs: saved.tabs, active: saved.active, open, close, activate };
}

export type AppTabsState = ReturnType<typeof useAppTabs>;

// AppTabBar 是顶栏下面的标签栏，没有打开任何应用时不显示。
export function AppTabBar({ state, portalTitle }: { state: AppTabsState; portalTitle: string }) {
  if (state.tabs.length === 0) return null;
  const current = state.tabs.find((t) => t.url === state.active);
  return (
    <div className="app-tabbar">
      <Tabs
        type="editable-card"
        size="small"
        hideAdd
        activeKey={state.active}
        onChange={state.activate}
        onEdit={(key, action) => action === "remove" && typeof key === "string" && state.close(key)}
        items={[
          { key: PORTAL_TAB, label: portalTitle, closable: false },
          ...state.tabs.map((t) => ({ key: t.url, label: t.title })),
        ]}
        tabBarExtraContent={
          current && (
            <Tooltip title="在新窗口打开">
              <Button
                type="text"
                size="small"
                icon={<ExportOutlined />}
                aria-label="在新窗口打开"
                onClick={() => window.open(currentURL(current), "_blank")}
              />
            </Tooltip>
          )
        }
      />
    </div>
  );
}

// AppFrames 放所有打开的应用。切换标签只是隐藏和显示，应用里填了一半的内容不会丢。
export function AppFrames({ state, onEmbeddedPortal }: { state: AppTabsState; onEmbeddedPortal: (tab: AppTab, url: string) => void }) {
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const latest = useRef(onEmbeddedPortal);
  latest.current = onEmbeddedPortal;

  useEffect(() => {
    function onEmbedded(e: Event) {
      const { frame, url } = (e as CustomEvent<EmbeddedDetail>).detail;
      const tab = state.tabs.find((t) => frames.current.get(t.url) === frame);
      if (!tab) return;
      e.preventDefault();
      latest.current(tab, url);
    }
    window.addEventListener(EMBEDDED_EVENT, onEmbedded);
    return () => window.removeEventListener(EMBEDDED_EVENT, onEmbedded);
  }, [state.tabs]);

  if (state.tabs.length === 0) return null;
  return (
    <div className="app-frames" style={state.active === PORTAL_TAB ? { display: "none" } : undefined}>
      {state.tabs.map((t) => (
        <iframe
          key={t.url}
          ref={(el) => {
            if (el) frames.current.set(t.url, el);
            else frames.current.delete(t.url);
          }}
          src={t.url}
          data-url={t.url}
          title={t.title}
          style={t.url !== state.active ? { display: "none" } : undefined}
        />
      ))}
    </div>
  );
}
