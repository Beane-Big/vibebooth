import { theme } from "antd";
import { useMemo } from "react";
import url from "../assets/wordmark.svg";
import svg from "../assets/wordmark.svg?raw";
import { useSiteInfo } from "../site";
import { themeID, useThemeMode } from "../theme";

// 字标原来的渐变（从左到右四个颜色），以及从渐变中间的颜色调深得到的投影色和描边色。
const original = svg.match(/<linearGradient id="fill"[^>]*>([\s\S]*?)<\/linearGradient>/)!;
const shadow = "#6a4fd8";
const outline = "#7b63e6";

// 主题写的颜色会拼进 SVG，只收简单的颜色写法，不让引号、尖括号混进去。
const safeColor = /^(#[0-9a-f]{3,8}|[a-z]+|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([0-9a-z.,%/\s-]*\))$/i;

// recolor 换掉字标的渐变颜色，投影和描边跟着渐变中间的颜色走；高光不变。
function recolor(colors: string[]) {
  const stops = colors
    .map((c, i) => `<stop offset="${colors.length === 1 ? 0 : i / (colors.length - 1)}" stop-color="${c}"/>`)
    .join("");
  const mid = colors[Math.floor((colors.length - 1) / 2)];
  return svg
    .replace(original[1], stops)
    .replace(`flood-color="${shadow}"`, `flood-color="${mid}"`)
    .replace(`stroke="${outline}"`, `stroke="${mid}"`);
}

// fromPrimary 从主题主色（#rrggbb）算出字标的渐变：色相往两边各偏 60 度，饱和度和亮度不变，像原来的蓝紫粉一样是一段相邻的颜色。
function fromPrimary(color: string) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return [];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return [-60, 0, 60].map((shift) => `hsl(${Math.round(h * 60 + shift + 360) % 360}, ${pct(s)}, ${pct(l)})`);
}

// Wordmark 是顶栏的平台字标：上传了自定义 Logo 时显示 Logo 与站点名；修改了站点名时按主题渐变色渲染文字字标；默认使用 Vibebooth 矢量字标。
export default function Wordmark() {
  const site = useSiteInfo();
  const { wordmark, skin } = useThemeMode();
  const { token } = theme.useToken();
  const colors = wordmark ?? (themeID(skin) ? fromPrimary(token.colorPrimary) : undefined);
  const safeColors = useMemo(
    () => (colors ?? []).filter((c) => safeColor.test(c)).slice(0, 4),
    [colors?.join("|")],
  );
  const src = useMemo(
    () => (safeColors.length ? `data:image/svg+xml,${encodeURIComponent(recolor(safeColors))}` : url),
    [safeColors.join("|")],
  );

  if (site.hasLogo && site.logoUrl) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <img src={site.logoUrl} alt={site.name} style={{ height: 26, width: "auto", maxWidth: 120, borderRadius: 6, objectFit: "contain" }} />
        <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: "-0.01em", color: "var(--text)" }}>{site.name}</span>
      </span>
    );
  }

  if (site.name && site.name !== "Vibebooth") {
    const gradient = safeColors.length >= 2
      ? `linear-gradient(90deg, ${safeColors.join(", ")})`
      : safeColors.length === 1
        ? safeColors[0]
        : "linear-gradient(90deg, #4b8bff, #7b63e6, #e668c4)";
    return (
      <span
        style={{
          fontWeight: 800,
          fontSize: 18,
          letterSpacing: "-0.02em",
          background: gradient,
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: safeColors.length === 1 ? undefined : "transparent",
          color: safeColors.length === 1 ? safeColors[0] : undefined,
          lineHeight: 1,
        }}
      >
        {site.name}
      </span>
    );
  }

  return <img src={src} alt={site.name || "Vibebooth"} />;
}
