import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { App as AntApp, ConfigProvider, theme as antTheme, type ThemeConfig } from "antd";
import zhCN from "antd/locale/zh_CN";

// 外观模式：浅色、深色、跟随系统。选择记在浏览器里，换设备要重新选。
export type ThemeMode = "light" | "dark" | "system";

// 门户的设计参数都集中在这里，风格照 Microsoft Fluent 2：中性灰底、白色卡片配轻阴影、4px 圆角的控件、品牌蓝。
// 颜色取自 Fluent 2 的 neutral / brand 色板。以后做“安装主题”时，主题包只需要提供这一组值。
const palette = {
  light: {
    colorPrimary: "#0f6cbd",
    colorError: "#c50f1f",
    colorSuccess: "#107c10",
    colorWarning: "#bc4b09",
    colorText: "#242424",
    colorTextSecondary: "#616161",
    colorBgLayout: "#f5f5f5",
    colorBgContainer: "#ffffff",
    colorBorder: "#d1d1d1",
    colorBorderSecondary: "#e0e0e0",
    // Fluent 的 shadow4 / shadow16：卡片和弹出层用。
    cardShadow: "0 0 2px rgba(0,0,0,0.12), 0 2px 4px rgba(0,0,0,0.14)",
    popupShadow: "0 0 2px rgba(0,0,0,0.12), 0 8px 16px rgba(0,0,0,0.14)",
    // 输入框底边比其他三边深一些，是 Fluent 输入框的特征。
    inputBottom: "#616161",
  },
  dark: {
    colorPrimary: "#479ef5",
    colorError: "#dc626d",
    colorSuccess: "#54b054",
    colorWarning: "#fa9e5e",
    colorText: "#ffffff",
    colorTextSecondary: "#adadad",
    colorBgLayout: "#1f1f1f",
    colorBgContainer: "#292929",
    colorBorder: "#666666",
    colorBorderSecondary: "#3d3d3d",
    cardShadow: "0 0 2px rgba(0,0,0,0.24), 0 2px 4px rgba(0,0,0,0.28)",
    popupShadow: "0 0 2px rgba(0,0,0,0.24), 0 8px 16px rgba(0,0,0,0.28)",
    inputBottom: "#d6d6d6",
  },
};

function themeConfig(dark: boolean): ThemeConfig {
  const { cardShadow, popupShadow, inputBottom: _, ...colors } = dark ? palette.dark : palette.light;
  return {
    algorithm: dark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
    token: {
      ...colors,
      // Fluent 的控件圆角是 4px，卡片和弹窗是 8px。
      borderRadius: 4,
      borderRadiusSM: 2,
      borderRadiusLG: 8,
      fontSize: 14,
      fontFamily: '"Segoe UI Variable", "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
      boxShadowSecondary: popupShadow,
      boxShadowTertiary: cardShadow,
      wireframe: false,
    },
    components: {
      Layout: { headerBg: colors.colorBgContainer, headerPadding: "0 16px", headerHeight: 56 },
      // 选中的导航项：文字加粗、下面一条 3px 的品牌色短线，和 Fluent 的 TabList 一样。
      Menu: {
        horizontalItemSelectedColor: colors.colorText,
        itemSelectedColor: colors.colorText,
        activeBarHeight: 3,
        horizontalLineHeight: "53px",
      },
      Button: { fontWeight: 600, primaryShadow: "none", defaultShadow: "none", dangerShadow: "none" },
      Card: { headerFontSize: 16 },
      Tag: { defaultBg: "transparent" },
    },
  };
}

const storageKey = "vb-theme";

function savedMode(): ThemeMode {
  try {
    const v = localStorage.getItem(storageKey);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // 浏览器禁用了本地存储时按跟随系统处理。
  }
  return "system";
}

function useSystemDark() {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const onChange = () => setDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
}

const ModeContext = createContext<{ mode: ThemeMode; setMode: (m: ThemeMode) => void }>({
  mode: "system",
  setMode: () => {},
});

export const useThemeMode = () => useContext(ModeContext);

// ThemeProvider 按外观模式套上 Ant Design 的主题，同时把颜色写成 CSS 变量，给门户自己的少量样式用。
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(savedMode);
  const systemDark = useSystemDark();
  const dark = mode === "dark" || (mode === "system" && systemDark);

  function setMode(m: ThemeMode) {
    setModeState(m);
    try {
      localStorage.setItem(storageKey, m);
    } catch {
      // 存不下也没关系，这次打开页面内有效。
    }
  }

  return (
    <ModeContext.Provider value={{ mode, setMode }}>
      {/* 关掉按钮文字自动加空格，“保存”不会显示成“保 存”。 */}
      <ConfigProvider locale={zhCN} theme={themeConfig(dark)} button={{ autoInsertSpace: false }}>
        <CssVars dark={dark} />
        <AntApp>{children}</AntApp>
      </ConfigProvider>
    </ModeContext.Provider>
  );
}

// CssVars 把当前主题的颜色写到 :root 上，变量名沿用门户和模块原来那一套（--bg、--surface 等）。
function CssVars({ dark }: { dark: boolean }) {
  const { token } = antTheme.useToken();
  useEffect(() => {
    const vars: Record<string, string> = {
      "--bg": token.colorBgLayout,
      "--surface": token.colorBgContainer,
      "--text": token.colorText,
      "--muted": token.colorTextSecondary,
      "--border": token.colorBorderSecondary,
      "--accent": token.colorPrimary,
      "--danger": token.colorError,
      "--radius": `${token.borderRadiusLG}px`,
      "--shadow": token.boxShadowTertiary,
      "--input-bottom": (dark ? palette.dark : palette.light).inputBottom,
    };
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    root.style.colorScheme = dark ? "dark" : "light";
  }, [token, dark]);
  return null;
}
