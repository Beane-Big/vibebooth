import { useMemo } from "react";
import url from "../assets/wordmark.svg";
import svg from "../assets/wordmark.svg?raw";
import { useThemeMode } from "../theme";

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

// Wordmark 是顶栏的平台字标。主题指定了字标颜色（ThemeOverrides.wordmark）时换成主题的颜色，否则是原来的蓝紫粉渐变。
export default function Wordmark() {
  const { wordmark } = useThemeMode();
  const key = wordmark?.join("|") ?? "";
  const src = useMemo(() => {
    const colors = key.split("|").filter((c) => safeColor.test(c)).slice(0, 4);
    return colors.length ? `data:image/svg+xml,${encodeURIComponent(recolor(colors))}` : url;
  }, [key]);
  return <img src={src} alt="Vibebooth" />;
}
