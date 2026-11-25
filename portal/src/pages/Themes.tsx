import { useEffect, useState, type ReactNode } from "react";
import { Alert, App as AntApp, Button, Card, Col, Flex, Row, Segmented, Space, Steps, Tabs, Tag, Typography, Upload } from "antd";
import {
  CheckOutlined,
  CopyOutlined,
  DownloadOutlined,
  PictureOutlined,
  SkinOutlined,
  StopOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { api, ApiError, hasPerm, isAdmin, maxWallpaperMB, type Me, type ThemeInfo, type Wallpaper } from "../api";
import { PackageDragger, ResultAlert, type OperationResult } from "../components/PackageUpload";
import { themeID, useThemeMode, wallpaperURL, type Skin } from "../theme";
import { THEMES_CHANGED_EVENT } from "../themeHost";
import { themeSkillUrl } from "./builder/api";
import classicShot from "../assets/skin-classic.jpg";
import tilesShot from "../assets/skin-tiles.jpg";

// 平台自带的“外观”应用：分「主题」「壁纸」「主题开发」（管理员可见）三个页签。
export default function Themes({ me, themes, entryPath }: { me: Me; themes: ThemeInfo[]; entryPath?: string }) {
  const { skin, ownSkin, setSkin, defaultSkin } = useThemeMode();
  const canManage = hasPerm(me, "modules");
  const admin = isAdmin(me);
  const [activeKey, setActiveKey] = useState(() => {
    if (entryPath === "/themes/wallpapers") return "wallpapers";
    if (admin && entryPath === "/themes/dev") return "dev";
    return "themes";
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OperationResult | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    if (entryPath === "/themes/wallpapers") setActiveKey("wallpapers");
    else if (admin && entryPath === "/themes/dev") setActiveKey("dev");
    else if (entryPath === "/themes") setActiveKey("themes");
  }, [admin, entryPath]);

  // 选用的主题被卸载了，按经典皮肤显示，这里也标经典为使用中。
  const installed = (s: Skin) => !themeID(s) || themes.some((t) => t.id === themeID(s));
  const current: Skin = installed(skin) ? skin : "classic";
  const platformDefault: Skin = installed(defaultSkin) ? defaultSkin : "classic";
  const following = ownSkin === null;
  const skins: SkinItem[] = [
    { skin: "classic", name: "经典", description: "带名称和说明的卡片", preview: classicShot },
    { skin: "tiles", name: "彩色方块", description: "大圆角的彩色图标，名称写在图标底部", preview: tilesShot },
    ...themes.map((t) => ({
      skin: `theme:${t.id}` as Skin,
      name: t.name,
      description: t.description,
      preview: t.preview && `/api/platform/themes/${t.id}/${t.preview}?v=${t.version}`,
      theme: t,
    })),
  ];

  async function run(action: () => Promise<{ log: string }>, success: string) {
    setBusy(true);
    setResult(null);
    try {
      const { log } = await action();
      setResult({ ok: true, message: success, log });
      window.dispatchEvent(new Event(THEMES_CHANGED_EVENT));
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) throw err;
      const log = err instanceof ApiError ? err.log : "";
      setResult({ ok: false, message: err instanceof Error ? err.message : "操作失败", log });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function uninstall(t: ThemeInfo) {
    setRemoving(null);
    const fallback = platformDefault === `theme:${t.id}` ? "平台默认皮肤换回经典，" : "";
    run(() => api.uninstallTheme(t.id), `${t.name} 已卸载，${fallback}自己选了它的人会改用平台默认皮肤。`);
  }

  function makeDefault(item: SkinItem) {
    run(
      () => api.setDefaultSkin(item.skin).then(() => ({ log: "" })),
      `平台默认皮肤已设为${item.name}，没有自己选皮肤的人都会用它。`,
    );
  }

  // 正在用的是平台默认皮肤时，“使用”默认皮肤就是改回跟随默认，管理员以后改默认时跟着变。
  function use(item: SkinItem) {
    setSkin(item.skin === platformDefault ? null : item.skin);
  }

  const themeTab = (
    <Flex vertical gap={16}>
      {result && <ResultAlert result={result} />}
      <Flex align="center" gap={12} wrap>
        <Typography.Text type="secondary">
          {following
            ? "你没有自己选主题，用的是平台默认主题，管理员改了默认会跟着变。"
            : "你自己选了主题，不跟随平台默认。"}
        </Typography.Text>
        {!following && <Button onClick={() => setSkin(null)}>跟随平台默认</Button>}
      </Flex>
      <Row gutter={[16, 16]}>
        {skins.map((item) => (
          <Col key={item.skin} xs={12} lg={8}>
            <Card
              className="theme-card"
              cover={
                item.preview ? (
                  <img className="theme-shot" src={item.preview} alt={`${item.name}的截图`} />
                ) : (
                  <Flex className="theme-shot" align="center" justify="center">
                    <SkinOutlined />
                  </Flex>
                )
              }
            >
              <Flex vertical gap={12}>
                <Flex vertical gap={4}>
                  <Space size={8} wrap>
                    <Typography.Text strong>{item.name}</Typography.Text>
                    {platformDefault === item.skin && <Tag color="processing">默认</Tag>}
                  </Space>
                  <Typography.Text type="secondary">{item.description || "\u00a0"}</Typography.Text>
                </Flex>
                <Space wrap>
                  {current === item.skin ? (
                    <Button icon={<CheckOutlined />} disabled>
                      使用中
                    </Button>
                  ) : (
                    <Button type="primary" onClick={() => use(item)}>
                      使用
                    </Button>
                  )}
                  {canManage && platformDefault !== item.skin && (
                    <Button disabled={busy} onClick={() => makeDefault(item)}>
                      设为默认
                    </Button>
                  )}
                  {canManage && item.theme && (
                    <Button
                      icon={<DownloadOutlined />}
                      href={`/api/platform/themes/${item.theme.id}/export`}
                      download={`${item.theme.id}-${item.theme.version}.zip`}
                    >
                      导出
                    </Button>
                  )}
                  {canManage &&
                    item.theme &&
                    (removing === item.theme.id ? (
                      <>
                        <Button danger type="primary" onClick={() => uninstall(item.theme!)} disabled={busy}>
                          确认卸载
                        </Button>
                        <Button onClick={() => setRemoving(null)}>取消</Button>
                      </>
                    ) : (
                      <Button disabled={busy} onClick={() => setRemoving(item.theme!.id)}>
                        卸载
                      </Button>
                    ))}
                </Space>
              </Flex>
            </Card>
          </Col>
        ))}
      </Row>
      {canManage && <InstallTheme busy={busy} run={run} />}
    </Flex>
  );

  return (
    <Tabs
      activeKey={activeKey}
      onChange={setActiveKey}
      items={[
        { key: "themes", label: "主题", children: themeTab },
        {
          key: "wallpapers",
          label: "壁纸",
          children: (
            <Flex vertical gap={16}>
              {result && <ResultAlert result={result} />}
              <Wallpapers canManage={canManage} busy={busy} run={run} />
            </Flex>
          ),
        },
        ...(admin
          ? [
              {
                key: "dev",
                label: "主题开发",
                children: <ThemeDevGuide onGoUpload={() => setActiveKey("themes")} />,
              },
            ]
          : []),
      ]}
    />
  );
}

type SkinItem = { skin: Skin; name: string; description: string; preview?: string; theme?: ThemeInfo };

type Run = (action: () => Promise<{ log: string }>, success: string) => Promise<boolean>;

// Wallpapers 是壁纸区：“不用壁纸”、必应每日壁纸和管理员上传的壁纸。
function Wallpapers({ canManage, busy, run }: { canManage: boolean; busy: boolean; run: Run }) {
  const { wallpaper, ownWallpaper, setWallpaper, defaultWallpaper } = useThemeMode();
  const [list, setList] = useState<Wallpaper[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api.wallpapers().then(setList, () => setList([]));
  }, [version]);

  const known = (id: string) => id === "" || id === "bing" || list.some((w) => w.id === id);
  const current = known(wallpaper) ? wallpaper : "";
  const platformDefault = known(defaultWallpaper) ? defaultWallpaper : "";
  const following = ownWallpaper === null;
  const items: WallpaperItem[] = [
    { id: "", name: "不用壁纸", description: "用主题自己的背景" },
    ...list.map((w) =>
      w.id === "bing"
        ? { id: w.id, name: w.title || "必应每日壁纸", description: w.copyright || "每天自动换一张必应首页的图片" }
        : { id: w.id, name: "上传的壁纸", description: "" },
    ),
  ];

  const use = (id: string) => setWallpaper(id === platformDefault ? null : id);

  async function change(action: () => Promise<unknown>, success: string) {
    const done = await run(() => action().then(() => ({ log: "" })), success);
    if (done) setVersion((v) => v + 1);
    return done;
  }

  function remove(id: string) {
    setRemoving(null);
    const fallback = platformDefault === id ? "平台默认改成不用壁纸，" : "";
    change(() => api.deleteWallpaper(id), `壁纸已删除，${fallback}选了它的人会改用平台默认壁纸。`);
  }

  function upload(file: File) {
    if (file.size > maxWallpaperMB << 20) {
      run(() => Promise.reject(new Error(`图片不能超过 ${maxWallpaperMB} MB`)), "");
      return;
    }
    change(() => api.uploadWallpaper(file), "壁纸已上传，在下面选用或设为默认。");
  }

  return (
    <Flex vertical gap={16}>
      <Flex align="center" justify="space-between" gap={12} wrap>
        <Flex align="center" gap={12} wrap>
          <Typography.Text type="secondary">
            {following
              ? "你没有自己选壁纸，用的是平台默认壁纸。"
              : "你自己选了壁纸，不跟随平台默认。"}
          </Typography.Text>
          {!following && <Button onClick={() => setWallpaper(null)}>跟随平台默认</Button>}
        </Flex>
        {canManage && (
          <Upload
            accept="image/jpeg,image/png,image/webp"
            showUploadList={false}
            disabled={busy}
            beforeUpload={(f) => {
              upload(f);
              return false;
            }}
          >
            <Button type="primary" icon={<UploadOutlined />} disabled={busy}>
              上传壁纸
            </Button>
          </Upload>
        )}
      </Flex>
      <Row gutter={[16, 16]}>
        {items.map((item) => (
          <Col key={item.id || "none"} xs={12} lg={8}>
            <Card className="theme-card" cover={<WallpaperShot id={item.id} name={item.name} />}>
              <Flex vertical gap={12}>
                <Flex vertical gap={4}>
                  <Space size={8} wrap>
                    <Typography.Text strong>{item.name}</Typography.Text>
                    {platformDefault === item.id && <Tag color="processing">默认</Tag>}
                  </Space>
                  <Typography.Text type="secondary" ellipsis={{ tooltip: item.description }}>
                    {item.description || " "}
                  </Typography.Text>
                </Flex>
                <Space wrap>
                  {current === item.id ? (
                    <Button icon={<CheckOutlined />} disabled>
                      使用中
                    </Button>
                  ) : (
                    <Button type="primary" onClick={() => use(item.id)}>
                      使用
                    </Button>
                  )}
                  {canManage && platformDefault !== item.id && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        change(() => api.setDefaultWallpaper(item.id), `平台默认壁纸已设为${item.name}，没有自己选壁纸的人都会用它。`)
                      }
                    >
                      设为默认
                    </Button>
                  )}
                  {canManage &&
                    item.id !== "" &&
                    item.id !== "bing" &&
                    (removing === item.id ? (
                      <>
                        <Button danger type="primary" onClick={() => remove(item.id)} disabled={busy}>
                          确认删除
                        </Button>
                        <Button onClick={() => setRemoving(null)}>取消</Button>
                      </>
                    ) : (
                      <Button disabled={busy} onClick={() => setRemoving(item.id)}>
                        删除
                      </Button>
                    ))}
                </Space>
              </Flex>
            </Card>
          </Col>
        ))}
      </Row>
    </Flex>
  );
}

type WallpaperItem = { id: string; name: string; description: string };

function WallpaperShot({ id, name }: { id: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const placeholder = (icon: ReactNode) => (
    <Flex className="theme-shot" align="center" justify="center">
      {icon}
    </Flex>
  );
  if (!id) return placeholder(<StopOutlined />);
  if (failed) return placeholder(<PictureOutlined />);
  return <img className="theme-shot wallpaper-shot" src={wallpaperURL(id, "thumb")} alt={`${name}的缩略图`} onError={() => setFailed(true)} />;
}

// InstallTheme 是上传主题包的卡片，只给有“应用管理”权限的人看。
function InstallTheme({ busy, run }: { busy: boolean; run: Run }) {
  const [file, setFile] = useState<File | null>(null);
  const [confirming, setConfirming] = useState(false);

  function install(allowScript = false) {
    if (!file) return;
    setConfirming(false);
    run(() => api.installTheme(file, allowScript), `${file.name} 已安装，在上面选用。`).then(
      (done) => done && setFile(null),
      () => setConfirming(true),
    );
  }

  return (
    <Card title="安装或升级主题">
      <Flex vertical gap={16}>
        <PackageDragger
          file={file}
          onChange={(f) => {
            setFile(f);
            setConfirming(false);
          }}
          disabled={busy}
          text="点击或把主题包（.zip）拖到这里"
        />
        <div>
          <Button type="primary" onClick={() => install()} disabled={!file} loading={busy}>
            {busy ? "处理中" : "安装"}
          </Button>
        </div>
        {confirming && (
          <Alert
            type="warning"
            showIcon
            message="这个主题带脚本，确认后才会安装"
            description={
              <Flex vertical gap={12}>
                <span>
                  脚本会在门户里以使用者的身份运行，能看到和操作他在平台上能看到的一切。只安装自己做的或可信来源的主题。
                </span>
                <Space wrap>
                  <Button danger type="primary" onClick={() => install(true)} disabled={busy}>
                    确认并安装
                  </Button>
                  <Button onClick={() => setConfirming(false)}>取消</Button>
                </Space>
              </Flex>
            }
          />
        )}
      </Flex>
    </Card>
  );
}

type ToolKey = "claude" | "cursor" | "codex" | "antigravity" | "other";

const themeToolGuides: Record<ToolKey, { label: string; path: string; step: string }> = {
  claude: {
    label: "Claude Code",
    path: "~/.claude/skills/vibebooth-theme-dev/",
    step: "解压后把 vibebooth-theme-dev 文件夹放进上述目录（或项目内 .claude/skills/），对话时告诉 AI 使用 vibebooth-theme-dev skill。",
  },
  cursor: {
    label: "Cursor",
    path: "~/.cursor/skills/vibebooth-theme-dev/",
    step: "解压后放进上述目录（或项目内 .cursor/skills/），在对话框里让 AI 按 vibebooth-theme-dev skill 设计主题。",
  },
  codex: {
    label: "Codex",
    path: "~/.codex/skills/vibebooth-theme-dev/",
    step: "解压后放进上述目录（或项目内 .agents/skills/），在指令里让它使用 vibebooth-theme-dev skill。",
  },
  antigravity: {
    label: "Antigravity",
    path: ".agent/skills/vibebooth-theme-dev/",
    step: "在界面导入解压后的 vibebooth-theme-dev 文件夹，或放进项目 .agent/skills/ 目录即可。",
  },
  other: {
    label: "其他 AI 工具",
    path: "vibebooth-theme-dev/SKILL.md",
    step: "把解压后的目录放进空文件夹，对话时先让 AI 阅读 vibebooth-theme-dev/SKILL.md，再按规范设计并打包。",
  },
};

const themePromptTemplates = [
  {
    title: "清新通透毛玻璃风",
    prompt:
      "使用 vibebooth-theme-dev skill，帮我设计一款「柔雾清晨」主题：浅蓝到淡紫的柔和渐变背景，半透明毛玻璃卡片，圆润柔和的图标配色，同时兼容浅色与深色模式，配一张预览图。完成后按 skill 规范自检并打包好上传用的主题包。",
  },
  {
    title: "治愈暖色手账风",
    prompt:
      "使用 vibebooth-theme-dev skill，帮我设计一款「奶油手账」主题：温暖的米白纸感底色、低饱和焦糖与鼠尾草绿点缀、卡片线条柔和、适合家庭日常使用，同时照顾好深色模式与壁纸叠加效果。完成后按 skill 规范自检并打包好上传用的主题包。",
  },
  {
    title: "深邃极光星空风",
    prompt:
      "使用 vibebooth-theme-dev skill，帮我设计一款「极光夜空」主题：深色模式下呈现蓝紫青极光渐变与玻璃质感，浅色模式下干净清爽，图标和顶栏字标呼应极光配色，配一张预览图。完成后按 skill 规范自检并打包好上传用的主题包。",
  },
  {
    title: "微调已有主题",
    prompt:
      "使用 vibebooth-theme-dev skill，帮我调整当前主题：【填写想调整的地方，如换主色、调大圆角、改首页卡片排布】，保持主题标识不变并调高版本号，完成后重新自检并打包。",
  },
];

function ThemeDevGuide({ onGoUpload }: { onGoUpload: () => void }) {
  const { message } = AntApp.useApp();
  const [tool, setTool] = useState<ToolKey>("claude");
  const activeTool = themeToolGuides[tool];

  async function copy(text: string, tip = "已复制") {
    try {
      await navigator.clipboard.writeText(text);
      message.success(tip);
    } catch {
      message.error("复制失败");
    }
  }

  return (
    <Flex vertical gap={16} style={{ maxWidth: 960 }}>
      <Card title="三步定制并安装专属主题">
        <Steps
          responsive
          items={[
            {
              title: "下载主题开发 Skill",
              status: "process",
              description: "获取主题规范与自动打包工具",
            },
            {
              title: "交给 AI 生成并打包",
              status: "wait",
              description: "描述想要的风格，自动输出主题包",
            },
            {
              title: "上传并立即启用",
              status: "wait",
              description: "回到「主题」页签上传即可换肤",
            },
          ]}
          style={{ marginBottom: 20 }}
        />
        <Space wrap>
          <Button type="primary" href={themeSkillUrl} icon={<DownloadOutlined />}>
            下载主题开发 Skill（.zip）
          </Button>
          <Button onClick={onGoUpload} icon={<UploadOutlined />}>
            前往主题页签上传
          </Button>
        </Space>
      </Card>

      <Card title="把 Skill 放入 AI 工具">
        <Flex vertical gap={12}>
          <Segmented
            value={tool}
            onChange={(v) => setTool(v as ToolKey)}
            options={Object.entries(themeToolGuides).map(([value, item]) => ({ value, label: item.label }))}
            style={{ alignSelf: "flex-start" }}
          />
          <Flex align="center" gap={8} wrap>
            <Typography.Text code>{activeTool.path}</Typography.Text>
            <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => copy(activeTool.path, "已复制路径")}>
              复制路径
            </Button>
          </Flex>
          <Typography.Text type="secondary">{activeTool.step}</Typography.Text>
        </Flex>
      </Card>

      <Card title="常用提示词示例">
        <Row gutter={[12, 12]}>
          {themePromptTemplates.map((item) => (
            <Col xs={24} md={12} key={item.title}>
              <Card
                size="small"
                title={item.title}
                extra={
                  <Button size="small" type="link" icon={<CopyOutlined />} onClick={() => copy(item.prompt, "已复制提示词")}>
                    复制
                  </Button>
                }
                style={{ height: "100%" }}
              >
                <Typography.Paragraph style={{ marginBottom: 0, fontSize: 13 }}>
                  {item.prompt}
                </Typography.Paragraph>
              </Card>
            </Col>
          ))}
        </Row>
      </Card>

      <Card size="small" title="小贴士">
        <Flex vertical gap={6}>
          <Typography.Text type="secondary">
            1. 主题无需构建，打包后的 .zip 在「主题」页签直接上传几秒就能启用。
          </Typography.Text>
          <Typography.Text type="secondary">
            2. 主题可以和「壁纸」搭配使用；若不满意或主题出错，随时可一键切回经典或设为默认。
          </Typography.Text>
        </Flex>
      </Card>
    </Flex>
  );
}
