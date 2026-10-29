import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { Component, type ComponentType, type ErrorInfo, type MouseEvent, type ReactNode } from "react";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Flex,
  Form,
  Grid,
  Input,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  theme,
} from "antd";
import { api, type ThemeInfo } from "./api";
import AppIcon from "./components/AppIcon";
import { themeID, useThemeMode, type ThemeOverrides } from "./theme";

// 安装的主题包（规范见 docs/theme-spec.md）在门户里运行：门户把自己的 React 和一部分 Ant Design 组件放在 window.vibebooth 上，
// 主题的脚本（IIFE 格式，构建时把 react、antd 指向这里）加载后调用 registerTheme 注册自己。
// 主题和门户共用同一份 React，组件才能互相嵌套；Ant Design 只给门户本来就用到的组件（加上 Badge），不让每个人多下载整个组件库。

// 主题规范版本，和 packages/manifest 的 SupportedThemePlatform 一致。
export const THEME_PLATFORM = 1;

// ThemeApp 是首页上的一个应用，平台自带的应用和模块统一成一种。
export type ThemeApp = {
  id: string;
  name: string;
  description: string;
  url: string;
  // 模块的图片图标网址，没有时为空。
  icon?: string;
  // 模块图标拆出来的图形（去掉底色的 SVG）网址和底色，图标拆不开时为空。主题给图标换颜色时用，一般直接交给 AppIcon。
  mask?: string;
  color?: string;
  // 平台自带的应用的图标（Ant Design 图标），模块没有。
  glyph?: ReactNode;
  // 平台自带的应用建议的渐变底色，从左上到右下。
  tint?: [string, string];
  healthy: boolean;
  builtin: boolean;
  // 放到 <a> 上：普通点击在门户里以标签页打开，按住 Ctrl / Cmd 或中键在浏览器新标签页打开。
  link: { href: string; onClick: (e: MouseEvent) => void };
};

export type HomeProps = {
  apps: ThemeApp[];
  dark: boolean;
  user: { displayName: string };
};

// ThemeDefinition 是主题注册的内容：外观设置（颜色参数、Ant Design 参数、背景、玻璃效果，见 theme.tsx 的 ThemeOverrides）
// 加上可选的首页组件。每一项都可以不写，不写的部分用经典皮肤的。
export type ThemeDefinition = ThemeOverrides & {
  // 替换首页的应用列表。
  Home?: ComponentType<HomeProps>;
};

const registered = new Map<string, ThemeDefinition>();
const loading = new Map<string, Promise<ThemeDefinition>>();

declare global {
  interface Window {
    vibebooth?: unknown;
  }
}

window.vibebooth = {
  platform: THEME_PLATFORM,
  React,
  jsxRuntime,
  antd: {
    Alert, Avatar, Badge, Button, Card, Checkbox, Col, Empty, Flex, Form, Grid, Input, Row, Segmented, Select,
    Space, Spin, Tag, Tooltip, Typography, theme,
  },
  // 门户的应用图标，按主题的 icons 上色，主题自己的首页用它画图标：<AppIcon app={app} />。
  AppIcon,
  // 主题的脚本在加载时同步调用它，门户从当前 <script> 上的 data-theme 认出是哪个主题。
  registerTheme(def: ThemeDefinition) {
    const id = (document.currentScript as HTMLScriptElement | null)?.dataset.theme;
    if (id) registered.set(id, def ?? {});
  },
};

const themeURL = (t: ThemeInfo, file: string) => `/api/platform/themes/${t.id}/${file}?v=${t.version}`;

// loadTheme 加载主题的脚本，返回它注册的内容；只有样式表的主题直接返回空定义。同一个版本只加载一次。
export function loadTheme(t: ThemeInfo): Promise<ThemeDefinition> {
  if (!t.script) return Promise.resolve({});
  const key = `${t.id}@${t.version}`;
  let p = loading.get(key);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = themeURL(t, t.script!);
      s.dataset.theme = t.id;
      s.onload = () => {
        const def = registered.get(t.id);
        def ? resolve(def) : reject(new Error("主题的脚本没有调用 registerTheme"));
      };
      s.onerror = () => reject(new Error("主题的脚本加载失败"));
      document.head.appendChild(s);
    });
    loading.set(key, p);
    p.catch(() => loading.delete(key));
  }
  return p;
}

// 主题管理页装好或卸载主题后发出这个事件，门户重新读主题列表。
export const THEMES_CHANGED_EVENT = "vb-themes-changed";

// useActiveTheme 读出已安装的主题和平台默认的皮肤，加载当前皮肤对应的主题包：套上它的颜色参数和样式表，返回它注册的内容。
// 自己选的主题被卸载了就改回跟随平台默认；加载失败时返回错误，由首页提示并退回经典皮肤。
export function useActiveTheme() {
  const { skin, ownSkin, setSkin, setDefaultSkin, setOverrides } = useThemeMode();
  const [themes, setThemes] = React.useState<ThemeInfo[]>([]);
  const [loaded, setLoaded] = React.useState<{ key: string; def?: ThemeDefinition; error?: string } | null>(null);
  // 读到过主题列表没有。列表回来之前它是空的，不能据此判断自己选的主题被卸载了。
  const [listed, setListed] = React.useState(false);

  React.useEffect(() => {
    const reload = () => {
      api.themes().then(
        (list) => {
          setThemes(list);
          setListed(true);
        },
        () => setThemes([]),
      );
      api.appearance().then((a) => setDefaultSkin(a.defaultSkin), () => {});
    };
    reload();
    window.addEventListener(THEMES_CHANGED_EVENT, reload);
    return () => window.removeEventListener(THEMES_CHANGED_EVENT, reload);
  }, []);

  React.useEffect(() => {
    if (!listed) return;
    const own = ownSkin && themeID(ownSkin);
    if (own && !themes.some((t) => t.id === own)) setSkin(null);
  }, [themes, listed]);

  const active = themes.find((t) => t.id === themeID(skin)) ?? null;
  const key = active ? `${active.id}@${active.version}` : "";
  React.useEffect(() => {
    if (!active) return;
    let current = true;
    loadTheme(active).then(
      (def) => current && setLoaded({ key, def }),
      (err: Error) => current && setLoaded({ key, error: err.message }),
    );
    return () => {
      current = false;
    };
  }, [key]);

  const ready = active && loaded?.key === key ? loaded : null;
  const def = ready?.def ?? null;
  React.useEffect(() => {
    setOverrides(def);
    return () => setOverrides(null);
  }, [def]);
  useThemeStyle(active);
  return { themes, active, def, error: ready?.error ?? "" };
}

// useThemeStyle 在选用主题时挂上它的样式表，换掉或不用时移走。
function useThemeStyle(t: ThemeInfo | null) {
  const href = t?.style ? themeURL(t, t.style) : "";
  React.useEffect(() => {
    if (!href) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
    return () => link.remove();
  }, [href]);
}

// ThemeBoundary 接住主题组件抛出的错误，显示门户自己的内容（fallback），并说明是哪个主题出的错。
export class ThemeBoundary extends Component<
  { name: string; fallback: ReactNode; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`主题 ${this.props.name} 出错`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <ThemeFallback name={this.props.name} error={this.state.error.message} fallback={this.props.fallback} />;
  }
}

export function ThemeFallback({ name, error, fallback }: { name: string; error: string; fallback: ReactNode }) {
  return (
    <>
      <Alert
        type="warning"
        showIcon
        message={`主题“${name}”出错了，先用经典皮肤显示`}
        description={error}
        style={{ marginBottom: 16 }}
      />
      {fallback}
    </>
  );
}
