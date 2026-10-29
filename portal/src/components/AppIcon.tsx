import type { CSSProperties, ReactNode } from "react";
import { useThemeMode } from "../theme";

// IconSource 是画一个应用图标要的东西，首页给主题的 ThemeApp 也是这个形状。
export type IconSource = {
  name: string;
  // 模块的图片图标网址。
  icon?: string;
  // 图标拆出来的图形（去掉底色的 SVG）网址和底色，图标拆不开时没有（见 core/icons.go）。
  mask?: string;
  color?: string;
  // 平台自带的应用的图标（Ant Design 图标）。
  glyph?: ReactNode;
  // 平台自带的应用的渐变底色，从左上到右下。
  tint?: [string, string];
};

// AppIcon 是首页上应用的图标，经典皮肤和主题的首页都用它。
// 主题指定了图标颜色（ThemeOverrides.icons）时按主题上色：底是 --icon-bg，图形是 --icon-fg；
// 模块的图形取自平台从 icon.svg 拆出来的图形层，当蒙版用，所以只有形状，颜色全由主题决定。
// 主题没指定时照原样：模块显示自己的图片，平台自带的应用和没有图片的模块是浅底上一个主色的图标或名称的第一个字。
// 拆不开的图片图标（PNG、图形有好几种颜色的 SVG）在主题下也照原样显示。
export default function AppIcon({ app }: { app: IconSource }) {
  const { themedIcons } = useThemeMode();
  const symbol = app.glyph ?? app.name.slice(0, 1);
  if (!themedIcons || (app.icon && !app.mask)) {
    return app.icon ? <img className="app-icon" src={app.icon} alt="" /> : <span className="app-icon app-icon-plain">{symbol}</span>;
  }
  const own = app.tint ? `linear-gradient(150deg, ${app.tint[0]}, ${app.tint[1]} 75%)` : (app.color ?? "var(--accent)");
  return (
    <span className="app-icon app-icon-themed" style={{ "--app-color": own } as CSSProperties}>
      {app.mask ? (
        <span className="app-icon-mask" style={{ maskImage: `url("${app.mask}")`, WebkitMaskImage: `url("${app.mask}")` }} />
      ) : (
        symbol
      )}
    </span>
  );
}
