import { useEffect, useState, type ReactNode } from "react";
import { Alert, Button, Card, Col, Flex, Row, Space, Tag, Typography, Upload } from "antd";
import { CheckOutlined, DownloadOutlined, PictureOutlined, SkinOutlined, StopOutlined, UploadOutlined } from "@ant-design/icons";
import { api, ApiError, hasPerm, maxWallpaperMB, type Me, type ThemeInfo, type Wallpaper } from "../api";
import { PackageDragger, ResultAlert, type OperationResult } from "../components/PackageUpload";
import { themeID, useThemeMode, wallpaperURL, type Skin } from "../theme";
import { THEMES_CHANGED_EVENT } from "../themeHost";
import classicShot from "../assets/skin-classic.jpg";
import tilesShot from "../assets/skin-tiles.jpg";

// 平台自带的“主题”应用：每个人在这里给自己选皮肤，选择存在自己的浏览器里；没选过的人用平台默认皮肤。
// 皮肤有内置的两种和管理员安装的主题包。有“应用管理”权限的人还能设平台默认皮肤、上传主题包安装或升级、导出主题包，以及卸载主题。
// 主题包的格式见 docs/theme-spec.md，用 create-vibebooth-theme 生成。
// 下面是壁纸：同样每人自己选、没选过的用平台默认；只在声明了使用平台壁纸的主题里显示。管理员能上传、删除壁纸和设默认。
export default function Themes({ me, themes }: { me: Me; themes: ThemeInfo[] }) {
  const { skin, ownSkin, setSkin, defaultSkin } = useThemeMode();
  const canManage = hasPerm(me, "modules");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OperationResult | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

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

  return (
    <Flex vertical gap={16}>
      {result && <ResultAlert result={result} />}
      <Flex align="center" gap={12} wrap>
        <Typography.Text type="secondary">
          {following
            ? "你没有自己选皮肤，用的是平台默认皮肤，管理员改了默认会跟着变。"
            : "你自己选了皮肤，不跟随平台默认。"}
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
                  <Typography.Text type="secondary">{item.description || " "}</Typography.Text>
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
                    // 导出成和上传时一样的主题包，能装到别的平台，或者在源码丢了时拿回装着的版本。
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
      <Wallpapers canManage={canManage} busy={busy} run={run} />
      {canManage && <InstallTheme busy={busy} run={run} />}
    </Flex>
  );
}

type SkinItem = { skin: Skin; name: string; description: string; preview?: string; theme?: ThemeInfo };

type Run = (action: () => Promise<{ log: string }>, success: string) => Promise<boolean>;

// Wallpapers 是壁纸区：“不用壁纸”、必应每日壁纸和管理员上传的壁纸，每张一张卡片，和上面的皮肤卡片一样。
function Wallpapers({ canManage, busy, run }: { canManage: boolean; busy: boolean; run: Run }) {
  const { wallpaper, ownWallpaper, setWallpaper, defaultWallpaper, wallpaperSupported } = useThemeMode();
  const [list, setList] = useState<Wallpaper[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api.wallpapers().then(setList, () => setList([]));
  }, [version]);

  // 列表回来之前只认识“不用壁纸”和必应，免得把上传的壁纸当成被删了。
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

  // 和皮肤一样：选平台默认的那张就是改回跟随默认。
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
    <Card
      title="壁纸"
      extra={
        canManage && (
          <Upload
            accept="image/jpeg,image/png,image/webp"
            showUploadList={false}
            disabled={busy}
            beforeUpload={(f) => {
              upload(f);
              return false;
            }}
          >
            <Button icon={<UploadOutlined />} disabled={busy}>
              上传壁纸
            </Button>
          </Upload>
        )
      }
    >
      <Flex vertical gap={16}>
        <Flex align="center" gap={12} wrap>
          <Typography.Text type="secondary">
            {following
              ? "你没有自己选壁纸，用的是平台默认壁纸。"
              : "你自己选了壁纸，不跟随平台默认。"}
            {!wallpaperSupported && "现在的皮肤不显示壁纸，换成支持壁纸的主题才看得到。"}
          </Typography.Text>
          {!following && <Button onClick={() => setWallpaper(null)}>跟随平台默认</Button>}
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
    </Card>
  );
}

type WallpaperItem = { id: string; name: string; description: string };

// WallpaperShot 是壁纸卡片上的缩略图。“不用壁纸”和取不到的图（比如服务器连不上必应）显示一个图标。
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
  // 主题带脚本时，安装器先拒绝，管理员确认后再带上 allowScript 装一次。
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
        <Typography.Text type="secondary">
          上传主题包（zip）：在主题仓库里用 <code>npm run pack</code> 生成的。主题可以换颜色、背景、组件样式和首页，
          已安装的主题会升级到包里的版本。
        </Typography.Text>
        <PackageDragger
          file={file}
          onChange={(f) => {
            setFile(f);
            setConfirming(false);
          }}
          disabled={busy}
          text="点击或把主题包拖到这里"
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
