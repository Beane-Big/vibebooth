import { useLayoutEffect, useState, type ReactNode } from "react";
import { App as AntApp, ConfigProvider, theme, type ThemeConfig } from "antd";
import zhCN from "antd/locale/zh_CN";

type HostTheme = { config?: ThemeConfig; css: string; classes: string[] };

// 部署时旧门户可能仍在浏览器中打开，而构建页已刷新为新版。直接读取同源宿主的实际主题，
// 作为握手完成前的兼容初值，避免白底和默认蓝色；独立访问或跨源嵌入不读取宿主。
function readHostTheme(): HostTheme | undefined {
  if (window.parent === window) return;
  try {
    const doc = window.parent.document;
    const root = doc.documentElement;
    const style = window.parent.getComputedStyle(root);
    const card = doc.querySelector<HTMLElement>(".ant-card");
    if (!card || !style.getPropertyValue("--accent").trim()) return;
    const cardStyle = window.parent.getComputedStyle(card);
    const button = doc.querySelector<HTMLElement>(".ant-btn-default");
    const buttonStyle = button
      ? window.parent.getComputedStyle(button)
      : undefined;
    const secondary = doc.querySelector<HTMLElement>(
      ".ant-typography-secondary",
    );
    const secondaryColor = secondary
      ? window.parent.getComputedStyle(secondary).color
      : style.getPropertyValue("--muted").trim();
    const variable = (name: string) => style.getPropertyValue(name).trim();
    return {
      config: {
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: variable("--accent"),
          colorText: variable("--text"),
          colorTextSecondary: variable("--muted"),
          colorTextDescription: secondaryColor,
          colorError: variable("--danger"),
          colorBgLayout: variable("--bg"),
          colorBgContainer: cardStyle.backgroundColor,
          colorBorder: buttonStyle?.borderColor || variable("--border"),
          colorBorderSecondary: variable("--border"),
          borderRadius: parseFloat(buttonStyle?.borderRadius || "14"),
          borderRadiusLG: parseFloat(cardStyle.borderRadius),
          controlHeight: parseFloat(buttonStyle?.height || "40"),
          fontFamily: cardStyle.fontFamily,
          fontSize: parseFloat(cardStyle.fontSize),
        },
        components: {
          Button: {
            fontWeight: 600,
            primaryShadow: "none",
            defaultShadow: "none",
          },
          Card: { headerFontSize: 16 },
          Tag: { defaultBg: "transparent" },
        },
      },
      css: `.ant-card { backdrop-filter: ${cardStyle.backdropFilter}; -webkit-backdrop-filter: ${cardStyle.backdropFilter}; box-shadow: ${cardStyle.boxShadow}; }`,
      classes: ["vb-glass", "vb-default-theme"].filter((name) =>
        root.classList.contains(name),
      ),
    };
  } catch {
    return;
  }
}

// 门户通过同源窗口传入完整主题；独立访问时使用与门户一致的基础尺寸和系统明暗模式。
export default function BuilderTheme({ children }: { children: ReactNode }) {
  const host = window as Window & { builderTheme?: HostTheme };
  const [value, setValue] = useState(
    () => host.builderTheme ?? readHostTheme(),
  );
  const [dark, setDark] = useState(
    matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useLayoutEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setDark(media.matches);
    let retry: ReturnType<typeof setTimeout>;
    let disposed = false;
    let attempts = 0;
    const receive = () => {
      if (host.builderTheme) {
        clearTimeout(retry);
        setValue(host.builderTheme);
      }
    };
    // 主动握手，不依赖父页的一次 load 通知；监听先安装，再请求，避免快速响应丢失。
    const requestTheme = () => {
      if (disposed || window.parent === window) return;
      window.parent.postMessage(
        { type: "vibebooth:builder-ready" },
        location.origin,
      );
      if (!host.builderTheme && ++attempts < 10)
        retry = setTimeout(requestTheme, 500);
    };
    window.addEventListener("vibebooth:builder-theme", receive);
    media.addEventListener("change", changed);
    let rootObserver: MutationObserver | undefined;
    try {
      if (window.parent !== window) {
        rootObserver = new MutationObserver(() => {
          if (!host.builderTheme) setValue(readHostTheme());
        });
        rootObserver.observe(window.parent.document.documentElement, {
          attributes: true,
          attributeFilter: ["style", "class"],
        });
      }
    } catch {
      /* 跨源嵌入不监听宿主。 */
    }
    // 主题包的 CSS 不属于 ConfigProvider 配置，也必须随同构建页加载。
    const links = new Map<string, HTMLLinkElement>();
    let headObserver: MutationObserver | undefined;
    try {
      if (window.parent !== window) {
        const parentHead = window.parent.document.head;
        const syncLinks = () => {
          const sources = new Set(
            Array.from(
              parentHead.querySelectorAll<HTMLLinkElement>(
                'link[rel="stylesheet"]',
              ),
              (link) => link.href,
            ),
          );
          for (const [href, link] of links) {
            if (!sources.has(href)) {
              link.remove();
              links.delete(href);
            }
          }
          for (const href of sources) {
            if (links.has(href)) continue;
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = href;
            document.head.append(link);
            links.set(href, link);
          }
        };
        syncLinks();
        headObserver = new MutationObserver(syncLinks);
        headObserver.observe(parentHead, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["href", "rel"],
        });
      }
    } catch {
      /* 跨源嵌入使用独立主题。 */
    }
    // 覆盖父页面在 React 挂载前已经发送主题的情况。
    receive();
    requestTheme();
    return () => {
      rootObserver?.disconnect();
      headObserver?.disconnect();
      links.forEach((link) => link.remove());
      disposed = true;
      clearTimeout(retry);
      window.removeEventListener("vibebooth:builder-theme", receive);
      media.removeEventListener("change", changed);
    };
  }, []);
  useLayoutEffect(() => {
    if (!value) return;
    // 旧门户只同步部分变量；兼容主题 CSS 对模糊、阴影等变量的引用。
    if (!host.builderTheme && window.parent !== window) {
      try {
        const source = window.parent.getComputedStyle(
          window.parent.document.documentElement,
        );
        for (const name of Array.from(source).filter((name) =>
          name.startsWith("--"),
        )) {
          document.documentElement.style.setProperty(
            name,
            source.getPropertyValue(name),
          );
        }
        document.documentElement.style.colorScheme = source.colorScheme;
      } catch {
        /* 跨源嵌入不读取宿主。 */
      }
    }
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
