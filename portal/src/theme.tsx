import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { App as AntApp, ConfigProvider, theme as antTheme, type ThemeConfig } from "antd";
import zhCN from "antd/locale/zh_CN";

// 外观模式：浅色、深色、跟随系统。选择记在浏览器里，换设备要重新选。
export type ThemeMode = "light" | "dark" | "system";

// 皮肤：首页应用的样子。classic 是带名称和说明的卡片；tiles 是大圆角的彩色方块图标、名称写在图标底部的半透明胶囊里，
// 照 joypixels.com 的应用区，排成静态网格不滚动；theme:<id> 是安装的主题包（见 themeHost.tsx）。和外观模式一样记在浏览器里。
export type Skin = "classic" | "tiles" | `theme:${string}`;

// themeID 返回皮肤对应的主题包 id，内置皮肤返回空。
export const themeID = (skin: Skin) => (skin.startsWith("theme:") ? skin.slice("theme:".length) : "");

// 门户的设计参数都集中在这里，风格照 Microsoft Fluent 2：中性灰底、白色卡片配轻阴影、4px 圆角的控件、品牌蓝。
// 颜色取自 Fluent 2 的 neutral / brand 色板。主题包可以改其中任意几个值（ThemeDefinition.tokens）。
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
    // 彩色方块皮肤里悬浮顶栏的阴影，比卡片的更柔更散。
    floatShadow: "0 10px 30px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.06)",
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
    floatShadow: "0 10px 30px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.3)",
    inputBottom: "#d6d6d6",
  },
};

export type Palette = typeof palette.light;

// 深浅色各一份的设置，主题包只写要改的那一边也行。
type PerMode<T> = { light?: T; dark?: T };

// Ant Design 的设计参数：token 是全局的（字号、圆角、颜色等），components 按组件调（Input、Select、Card、Typography……）。
export type AntdOverrides = Pick<ThemeConfig, "token" | "components">;

// ThemeOverrides 是主题包能改的外观，规范见 docs/theme-spec.md。
export type ThemeOverrides = {
  // 门户的颜色参数（上面的 palette），只写要改的。
  tokens?: PerMode<Partial<Palette>>;
  // Ant Design 的参数，在 palette 之后套上，可以改任何组件。
  antd?: PerMode<AntdOverrides>;
  // 页面背景，CSS 的 background 写法：颜色、渐变或图片。图片要写完整网址，主题包里的文件用脚手架提供的 asset() 算出网址。
  background?: PerMode<string>;
  // 玻璃效果：卡片、顶栏、弹出层变成半透明并模糊后面的背景，和 iOS 的毛玻璃一样。opacity 是底色不透明度。
  glass?: boolean | { blur?: number; opacity?: number };
};

const pick = <T,>(v: PerMode<T> | undefined, dark: boolean) => (dark ? v?.dark : v?.light);

const paletteFor = (dark: boolean, o?: ThemeOverrides): Palette => ({
  ...(dark ? palette.dark : palette.light),
  ...pick(o?.tokens, dark),
});

export function glassOf(o?: ThemeOverrides) {
  if (!o?.glass) return null;
  const g = o.glass === true ? {} : o.glass;
  return { blur: g.blur ?? 20, opacity: g.opacity ?? 0.6 };
}

// translucent 给 #rgb / #rrggbb 颜色加上透明度，其他写法原样返回。
function translucent(color: string, alpha: number) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function themeConfig(p: Palette, dark: boolean, o?: ThemeOverrides): ThemeConfig {
  const { cardShadow, popupShadow, floatShadow: _f, inputBottom: _, ...colors } = p;
  const base = baseConfig(colors, cardShadow, popupShadow, dark);
  const glass = glassOf(o);
  if (glass) {
    const surface = translucent(colors.colorBgContainer, glass.opacity);
    // 弹出层（下拉菜单、弹窗）比卡片不透明一些，叠在内容上也看得清字。
    const elevated = translucent(dark ? "#2b2b2b" : "#ffffff", Math.min(1, glass.opacity + 0.2));
    base.token = { ...base.token, colorBgContainer: surface, colorBgElevated: elevated };
    base.components = { ...base.components, Layout: { ...base.components!.Layout, headerBg: surface } };
  }
  const extra = pick(o?.antd, dark);
  if (!extra) return base;
  const components: Record<string, object> = { ...base.components };
  for (const [name, value] of Object.entries(extra.components ?? {})) components[name] = { ...components[name], ...value };
  return { ...base, token: { ...base.token, ...extra.token }, components };
}

type Colors = Omit<Palette, "cardShadow" | "popupShadow" | "floatShadow" | "inputBottom">;

function baseConfig(colors: Colors, cardShadow: string, popupShadow: string, dark: boolean): ThemeConfig {
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
const skinKey = "vb-skin";

function saved<T extends string>(key: string, valid: (v: string) => boolean, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v !== null && valid(v)) return v as T;
  } catch {
    // 浏览器禁用了本地存储时用默认值：外观跟随系统，皮肤用经典。
  }
  return fallback;
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存不下也没关系，这次打开页面内有效。
  }
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

const ModeContext = createContext<{
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  skin: Skin;
  setSkin: (s: Skin) => void;
  dark: boolean;
  // 选用的主题包加载好以后，由门户把它的外观设置交给这里；null 表示不改。
  setOverrides: (o: ThemeOverrides | null) => void;
}>({
  mode: "system",
  setMode: () => {},
  skin: "classic",
  setSkin: () => {},
  dark: false,
  setOverrides: () => {},
});

export const useThemeMode = () => useContext(ModeContext);

// ThemeProvider 按外观模式套上 Ant Design 的主题，同时把颜色写成 CSS 变量，给门户自己的少量样式用。
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() =>
    saved(storageKey, (v) => ["light", "dark", "system"].includes(v), "system"),
  );
  const [skin, setSkinState] = useState<Skin>(() =>
    saved(skinKey, (v) => v === "classic" || v === "tiles" || /^theme:[a-z][a-z0-9-]{1,30}$/.test(v), "classic"),
  );
  const [overrides, setOverrides] = useState<ThemeOverrides | null>(null);
  const systemDark = useSystemDark();
  const dark = mode === "dark" || (mode === "system" && systemDark);
  const p = paletteFor(dark, overrides ?? undefined);

  function setMode(m: ThemeMode) {
    setModeState(m);
    save(storageKey, m);
  }

  function setSkin(s: Skin) {
    setSkinState(s);
    save(skinKey, s);
  }

  return (
    <ModeContext.Provider value={{ mode, setMode, skin, setSkin, dark, setOverrides }}>
      {/* 关掉按钮文字自动加空格，“保存”不会显示成“保 存”。 */}
      <ConfigProvider locale={zhCN} theme={themeConfig(p, dark, overrides ?? undefined)} button={{ autoInsertSpace: false }}>
        <CssVars dark={dark} p={p} o={overrides ?? undefined} />
        <AntApp>{children}</AntApp>
      </ConfigProvider>
    </ModeContext.Provider>
  );
}

// CssVars 把当前主题的颜色写到 :root 上，变量名沿用门户和模块原来那一套（--bg、--surface 等）。
// 主题包设了背景或玻璃效果时，再在 <html> 上加 vb-has-bg、vb-glass，styles.css 据此让页面透出背景。
function CssVars({ dark, p, o }: { dark: boolean; p: Palette; o?: ThemeOverrides }) {
  const background = pick(o?.background, dark) ?? "";
  const glass = glassOf(o);
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
      "--input-bottom": p.inputBottom,
      "--float-shadow": p.floatShadow,
      "--page-bg": background || token.colorBgLayout,
      "--glass-blur": `${glass?.blur ?? 0}px`,
    };
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    root.style.colorScheme = dark ? "dark" : "light";
    root.classList.toggle("vb-has-bg", !!background);
    root.classList.toggle("vb-glass", !!glass);
  }, [token, dark, p.inputBottom, p.floatShadow, background, glass?.blur]);
  return null;
}
