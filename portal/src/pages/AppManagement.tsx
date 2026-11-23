import { useContext, useEffect, useRef, useState } from "react";
import { ConfigProvider, Tabs } from "antd";
import { isAdmin, type Me } from "../api";
import Modules from "./Modules";
import componentStyles from "../componentTheme.css?inline";

// 安装管理和构建共用一个应用入口，构建器仅管理员可用。
export default function AppManagement({ me }: { me: Me }) {
  return (
    <Tabs
      items={[
        {
          key: "modules",
          label: "应用管理",
          children: <Modules canManageAccess={isAdmin(me)} />,
        },
        ...(isAdmin(me)
          ? [{ key: "build", label: "应用构建", children: <BuilderContent /> }]
          : []),
      ]}
    />
  );
}

// BuilderContent 让构建内容参与门户的整页滚动，不再使用固定视口中的独立滚动区。
// 同源页面每次导航后重新观察，日志展开、列表更新、窗口变化时同步自然高度。
function BuilderContent() {
  const { theme: componentTheme } = useContext(ConfigProvider.ConfigContext);
  const currentTheme = useRef(componentTheme);
  currentTheme.current = componentTheme;
  const updateTheme = useRef<(() => void) | null>(null);
  useEffect(() => {
    updateTheme.current?.();
  }, [componentTheme]);
  const [height, setHeight] = useState(520);
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    // 子页可能在 load 通知前后才挂载，也可能在设置页导航后重新加载；以实际就绪通知重连。
    const ready = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== frameRef.current?.contentWindow ||
        event.data?.type !== "vibebooth:builder-ready"
      )
        return;
      connect();
    };
    window.addEventListener("message", ready);
    return () => window.removeEventListener("message", ready);
  }, []);
  const dispose = useRef<(() => void) | null>(null);
  useEffect(() => () => dispose.current?.(), []);

  function connect() {
    dispose.current?.();
    dispose.current = null;
    const frame = frameRef.current;
    if (!frame) return;
    const doc = frame.contentDocument;
    if (!doc) return;
    if (doc.location.pathname === "/login") {
      location.assign("/login?next=%2Fapplications");
      return;
    }
    const root = doc.getElementById("root");
    if (!root) return;
    const resize = new ResizeObserver(() => {
      const rect = root.getBoundingClientRect();
      // 页签隐藏时不把内容高度压成 0，重新显示后观察器会再次测量。
      if (rect.width > 0 && rect.height > 0) setHeight(Math.ceil(rect.height));
    });
    resize.observe(root);
    // 构建器与门户共享当前配色，主题切换时保持一致。
    const syncTheme = () => {
      const style = getComputedStyle(document.documentElement);
      for (const name of [
        "--bg",
        "--surface",
        "--text",
        "--muted",
        "--border",
        "--accent",
        "--danger",
        "--radius",
        "--shadow",
        "--glass-blur",
      ]) {
        doc.documentElement.style.setProperty(
          name,
          style.getPropertyValue(name),
        );
      }
      doc.documentElement.style.colorScheme = style.colorScheme;
      // 同源构建页使用完整组件主题与同一份主题 CSS，避免只同步颜色后尺寸和状态仍不同。
      const detail = {
        config: currentTheme.current,
        css: componentStyles,
        classes: ["vb-glass", "vb-default-theme"].filter((name) =>
          document.documentElement.classList.contains(name),
        ),
      };
      const target = frame.contentWindow as
        (Window & { builderTheme?: typeof detail }) | null;
      if (target) {
        target.builderTheme = detail;
        target.dispatchEvent(
          new CustomEvent("vibebooth:builder-theme", { detail }),
        );
      }
    };
    updateTheme.current = syncTheme;
    syncTheme();
    const theme = new MutationObserver(syncTheme);
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    dispose.current = () => {
      updateTheme.current = null;
      resize.disconnect();
      theme.disconnect();
    };
  }

  return (
    <iframe
      className="application-builder-frame"
      data-platform-layout="content"
      title="应用构建"
      src="/apps/builder/"
      style={{ height }}
      ref={frameRef}
      onLoad={connect}
    />
  );
}
