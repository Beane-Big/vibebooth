import { useLayoutEffect, useState, type ReactNode } from "react";
import { App as AntApp, ConfigProvider, theme, type ThemeConfig } from "antd";
import zhCN from "antd/locale/zh_CN";

type HostTheme = { config?: ThemeConfig; css: string; classes: string[] };

// 门户通过同源窗口传入完整主题；独立访问时使用与门户一致的基础尺寸和系统明暗模式。
export default function BuilderTheme({ children }: { children: ReactNode }) {
  const host = window as Window & { builderTheme?: HostTheme };
  const [value, setValue] = useState(host.builderTheme);
  const [dark, setDark] = useState(
    matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useLayoutEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setDark(media.matches);
    const receive = () => setValue(host.builderTheme);
    window.addEventListener("vibebooth:builder-theme", receive);
    media.addEventListener("change", changed);
    // 覆盖父页面在 React 挂载前已经发送主题的情况。
    receive();
    return () => {
      window.removeEventListener("vibebooth:builder-theme", receive);
      media.removeEventListener("change", changed);
    };
  }, []);
  useLayoutEffect(() => {
    if (!value) return;
    const style = document.createElement("style");
    style.textContent = value.css;
    document.head.append(style);
    for (const name of ["vb-glass", "vb-default-theme"])
      document.documentElement.classList.toggle(
        name,
        value.classes.includes(name),
      );
    return () => {
      style.remove();
    };
  }, [value]);
  const fallback: ThemeConfig = {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: "#245ed0",
      borderRadius: 14,
      borderRadiusSM: 10,
      borderRadiusLG: 24,
      controlHeight: 40,
      fontSize: 14,
      fontFamily:
        '\"Segoe UI Variable\", \"Segoe UI\", -apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Microsoft YaHei\", sans-serif',
    },
    components: {
      Button: {
        fontWeight: 600,
        primaryShadow: "none",
        defaultShadow: "none",
        dangerShadow: "none",
      },
      Card: { headerFontSize: 16 },
      Tag: { defaultBg: "transparent" },
    },
  };
  return (
    <ConfigProvider
      locale={zhCN}
      theme={value?.config ?? fallback}
      button={{ autoInsertSpace: false }}
    >
      <ThemeSurface embedded={!!value}>{children}</ThemeSurface>
    </ConfigProvider>
  );
}

// 普通文字继承公共组件字体；独立访问时也为日志和页面背景提供主题变量。
function ThemeSurface({
  embedded,
  children,
}: {
  embedded: boolean;
  children: ReactNode;
}) {
  const { token } = theme.useToken();
  useLayoutEffect(() => {
    if (embedded) return;
    const root = document.documentElement;
    root.style.setProperty("--bg", token.colorBgLayout);
    root.style.setProperty("--text", token.colorText);
  }, [embedded, token.colorBgLayout, token.colorText]);
  return <AntApp>{children}</AntApp>;
}
