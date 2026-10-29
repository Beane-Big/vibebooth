import type { MouseEvent, ReactNode } from "react";
import { Card, Col, Empty, Row, Spin, Tag, Typography } from "antd";
import type { App, Me, ThemeInfo } from "../api";
import type { BuiltinApp } from "../builtin";
import AppIcon from "../components/AppIcon";
import type { AppTab } from "../components/AppTabs";
import { inPlace } from "../components/Layout";
import { useThemeMode } from "../theme";
import { ThemeBoundary, ThemeFallback, type ThemeApp, type ThemeDefinition } from "../themeHost";

type Props = {
  apps: App[];
  builtins: BuiltinApp[];
  onOpen: (tab: AppTab) => void;
};

// 首页列出能打开的应用，平台自带的应用（用户、设置）排在前面。
// 点卡片在门户里以标签页打开；按住 Ctrl / Cmd 或用中键点击时在浏览器新标签页打开，登录状态共享。
// 选用的主题包带了首页组件时由它来画；主题还没加载好时转圈，出错时提示并用经典皮肤。
export default function Home({
  user,
  theme,
  ...props
}: Props & {
  user: Me;
  theme: { active: ThemeInfo | null; def: ThemeDefinition | null; error: string } | null;
}) {
  const { skin, dark } = useThemeMode();
  if (props.apps.length === 0 && props.builtins.length === 0) return <Empty description="还没有可用的应用。" />;
  if (theme?.active) {
    const { name } = theme.active;
    if (theme.error) return <ThemeFallback name={name} error={theme.error} fallback={<ClassicHome {...props} />} />;
    if (!theme.def) return <Spin style={{ display: "block", margin: "48px auto" }} />;
    const ThemeHome = theme.def.Home;
    if (ThemeHome) {
      return (
        <ThemeBoundary key={name} name={name} fallback={<ClassicHome {...props} />}>
          <ThemeHome apps={themeApps(props)} dark={dark} user={{ displayName: user.displayName }} />
        </ThemeBoundary>
      );
    }
  }
  return skin === "tiles" ? <TilesHome {...props} /> : <ClassicHome {...props} />;
}

// themeApps 把平台自带的应用和模块统一成交给主题的格式。
function themeApps({ apps, builtins, onOpen }: Props): ThemeApp[] {
  const link = (tab: AppTab) => ({
    href: tab.url,
    onClick: (e: MouseEvent) => {
      if (!inPlace(e)) return;
      e.preventDefault();
      onOpen(tab);
    },
  });
  return [
    ...builtins.map((app) => ({
      id: app.id,
      name: app.name,
      description: app.description,
      url: app.url,
      glyph: app.icon,
      tint: app.tint,
      healthy: true,
      builtin: true,
      link: link({ url: app.url, title: app.name }),
    })),
    ...apps.map((app) => ({
      id: app.id,
      name: app.name,
      description: app.description,
      url: app.url,
      icon: app.icon,
      mask: app.glyph,
      color: app.color,
      healthy: app.healthy,
      builtin: false,
      link: link({ url: app.url, title: app.name }),
    })),
  ];
}

// 彩色方块皮肤。
function TilesHome({ apps, builtins, onOpen }: Props) {
  return (
    <div className="app-tiles">
      {builtins.map((app) => (
        <AppTile
          key={app.id}
          tab={{ url: app.url, title: app.name }}
          icon={<span className="app-tile-glyph">{app.icon}</span>}
          tint={app.tint}
          description={app.description}
          onOpen={onOpen}
        />
      ))}
      {apps.map((app) => (
        <AppTile
          key={app.id}
          tab={{ url: app.url, title: app.name }}
          icon={<span className="app-tile-glyph">{app.name.slice(0, 1)}</span>}
          image={app.icon}
          description={app.description}
          unhealthy={!app.healthy}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

// 经典皮肤：带名称和说明的卡片。
function ClassicHome({ apps, builtins, onOpen }: Props) {
  return (
    <Row gutter={[16, 16]}>
      {builtins.map((app) => (
        <AppCard
          key={app.id}
          tab={{ url: app.url, title: app.name }}
          icon={<AppIcon app={{ name: app.name, glyph: app.icon, tint: app.tint }} />}
          description={app.description}
          onOpen={onOpen}
        />
      ))}
      {apps.map((app) => (
        <AppCard
          key={app.id}
          tab={{ url: app.url, title: app.name }}
          icon={<AppIcon app={{ name: app.name, icon: app.icon, mask: app.glyph, color: app.color }} />}
          description={app.description || " "}
          unhealthy={!app.healthy}
          onOpen={onOpen}
        />
      ))}
    </Row>
  );
}

// AppCard 是一张应用卡片，点击在门户里以标签页打开，卡片上的名称就是标签标题。
function AppCard({
  tab,
  icon,
  description,
  unhealthy = false,
  onOpen,
}: {
  tab: AppTab;
  icon: ReactNode;
  description: string;
  unhealthy?: boolean;
  onOpen: (tab: AppTab) => void;
}) {
  return (
    <Col xs={24} sm={12} lg={8} xxl={6}>
      <a
        href={tab.url}
        onClick={(e) => {
          if (!inPlace(e)) return;
          e.preventDefault();
          onOpen(tab);
        }}
      >
        <Card hoverable size="small" styles={{ body: { padding: 16 } }}>
          <div className="app-card">
            {icon}
            <div className="app-text">
              <Typography.Text strong ellipsis>
                {tab.title}
                {unhealthy && (
                  <Tag color="error" style={{ marginInlineStart: 8 }}>
                    不可用
                  </Tag>
                )}
              </Typography.Text>
              <Typography.Text type="secondary" ellipsis>
                {description}
              </Typography.Text>
            </div>
          </div>
        </Card>
      </a>
    </Col>
  );
}

// AppTile 是彩色方块皮肤里的一个应用：图标铺满圆角方块，名称在底部的半透明胶囊里；说明不显示，鼠标停在上面时提示。
// 模块的图标本身就是满底色的方块：把图标左边缘的底色放大铺满方块当底色，图标原样缩小放在中间，两层同色看不出接缝；
// 这两层再复制一份，转一点色相、提亮，从左上往右下淡出，叠在上面，单色的图标也有双色渐变（白色图形转色相后还是白色）；
// 最上面是左上角的光斑和边缘高光。
// 底下的彩色阴影是同一张图标模糊后的影子。
// 平台自带的应用和没有图片的模块用双色渐变底色加白色图形，没指定颜色时从品牌色算出一对颜色。
function AppTile({
  tab,
  icon,
  image,
  tint,
  description,
  unhealthy = false,
  onOpen,
}: {
  tab: AppTab;
  // 没有图片时显示的白色图形。
  icon: ReactNode;
  image?: string;
  tint?: [string, string];
  description: string;
  unhealthy?: boolean;
  onOpen: (tab: AppTab) => void;
}) {
  const art = image && (
    <>
      <img className="app-tile-fill" src={image} alt="" />
      <img className="app-tile-img" src={image} alt="" />
    </>
  );
  const [from, to] = tint ?? ["oklch(from var(--accent) calc(l + 0.15) c calc(h - 40))", "var(--accent)"];
  return (
    <a
      href={tab.url}
      className={unhealthy ? "app-tile unhealthy" : "app-tile"}
      title={description || undefined}
      onClick={(e) => {
        if (!inPlace(e)) return;
        e.preventDefault();
        onOpen(tab);
      }}
    >
      <span className="app-tile-square">
        {image ? (
          <img className="app-tile-shadow" src={image} alt="" />
        ) : (
          <span className="app-tile-shadow" style={{ background: to }} />
        )}
        <span className="app-tile-face" style={image ? undefined : { background: `linear-gradient(150deg, ${from}, ${to} 75%)` }}>
          {art ? (
            <>
              <span className="app-tile-art">{art}</span>
              <span className="app-tile-art app-tile-tint">{art}</span>
            </>
          ) : (
            icon
          )}
          <span className="app-tile-label">{unhealthy ? `${tab.title} · 不可用` : tab.title}</span>
        </span>
      </span>
    </a>
  );
}
