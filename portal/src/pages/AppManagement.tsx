import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Tabs } from "antd";
import { isAdmin, type Me } from "../api";
import Modules from "./Modules";

// 安装管理和构建共用一个应用入口，构建器仅管理员可用。
export default function AppManagement({ me }: { me: Me }) {
  return <Tabs items={[
    { key: "modules", label: "应用管理", children: <Modules canManageAccess={isAdmin(me)} /> },
    ...(isAdmin(me) ? [{ key: "build", label: "应用构建", children: <BuilderContent /> }] : []),
  ]} />;
}

// BuilderContent 让构建内容参与门户的整页滚动，不再使用固定视口中的独立滚动区。
// 同源页面每次导航后重新观察，日志展开、列表更新、窗口变化时同步自然高度。
function BuilderContent() {
  const [height, setHeight] = useState(520);
  const dispose = useRef<(() => void) | null>(null);
  useEffect(() => () => dispose.current?.(), []);

  function loaded(event: SyntheticEvent<HTMLIFrameElement>) {
    dispose.current?.();
    dispose.current = null;
    const frame = event.currentTarget;
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
      for (const name of ["--bg", "--surface", "--text", "--muted", "--border", "--accent", "--danger", "--radius"]) {
        doc.documentElement.style.setProperty(name, style.getPropertyValue(name));
      }
      doc.documentElement.style.colorScheme = style.colorScheme;
    };
    syncTheme();
    const theme = new MutationObserver(syncTheme);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    dispose.current = () => { resize.disconnect(); theme.disconnect(); };
  }

  return <iframe className="application-builder-frame" data-platform-layout="content" title="应用构建"
    src="/apps/builder/" style={{ height }} onLoad={loaded} />;
}
