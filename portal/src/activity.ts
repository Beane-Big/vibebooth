import { useEffect, useRef } from "react";
import { api } from "./api";
import { builtinApps } from "./builtin";
import { PORTAL_TAB } from "./components/AppTabs";

// 活跃度统计的心跳（见 core/stats.go）：页面可见、最近 idleAfter 内有人操作过时，每分钟报一次正在看哪个标签，
// 服务器把一次心跳算作一分钟；切到一个标签时马上报一次“打开”。统计关着时服务器不记，门户照常发，不用知道开关。
// 平板一直亮着屏放在那里没人动时不算，所以要看有没有操作：门户自己的页面，以及同源的模块内嵌页里的点击、按键、滚动。
const beatInterval = 60_000;
const idleAfter = 5 * 60_000;
const activityEvents = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

// statsApp 把标签换成统计里的应用：首页是 portal，自带应用是 portal:<id>，模块是模块 id。
function statsApp(tab: string) {
  if (tab === PORTAL_TAB) return "portal";
  const builtin = builtinApps.find((app) => app.url === tab);
  if (builtin) return `portal:${builtin.id}`;
  return /^\/apps\/([^/?#]+)/.exec(tab)?.[1] ?? "";
}

// iPadOS 的 Safari 默认报 Mac 的 User-Agent，服务器靠这个区分平板和电脑。
const touch = () => navigator.maxTouchPoints > 1;

export function useActivityBeat(activeTab: string) {
  const lastInput = useRef(Date.now());
  const active = useRef(activeTab);
  active.current = activeTab;

  // 记下最近一次操作的时间。模块的内嵌页每次加载都是新的窗口，要在加载后重新监听；拿不到内嵌页的窗口（以后换成独立域名）时只看门户自己。
  useEffect(() => {
    const touched = () => (lastInput.current = Date.now());
    const watch = (win: Window) => activityEvents.forEach((e) => win.addEventListener(e, touched, { passive: true, capture: true }));
    watch(window);
    const frames = new WeakSet<HTMLIFrameElement>();
    const watchFrame = (frame: HTMLIFrameElement) => {
      try {
        if (frame.contentWindow) watch(frame.contentWindow);
      } catch {
        // 跨域的内嵌页拿不到窗口。
      }
    };
    const scan = () =>
      document.querySelectorAll<HTMLIFrameElement>(".app-frames iframe").forEach((frame) => {
        if (frames.has(frame)) return;
        frames.add(frame);
        frame.addEventListener("load", () => watchFrame(frame));
        watchFrame(frame);
      });
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      activityEvents.forEach((e) => window.removeEventListener(e, touched, { capture: true }));
    };
  }, []);

  // 切到一个标签：算一次打开，也算有人操作。
  useEffect(() => {
    lastInput.current = Date.now();
    beat(activeTab, true);
  }, [activeTab]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (Date.now() - lastInput.current < idleAfter) beat(active.current, false);
    }, beatInterval);
    // 页面从后台切回来时也报一次，免得要等一分钟。
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      lastInput.current = Date.now();
      beat(active.current, false);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}

function beat(tab: string, open: boolean) {
  const app = statsApp(tab);
  if (!app || document.visibilityState !== "visible") return;
  // 统计失败不影响使用，也不打扰用户。
  api.statsBeat(app, open, touch()).catch(() => {});
}
