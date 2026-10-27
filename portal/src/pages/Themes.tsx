import { useState } from "react";
import { Alert, Button, Card, Col, Flex, Row, Space, Tag, Typography } from "antd";
import { CheckOutlined, SkinOutlined } from "@ant-design/icons";
import { api, ApiError, hasPerm, type Me, type ThemeInfo } from "../api";
import { PackageDragger, ResultAlert, type OperationResult } from "../components/PackageUpload";
import { themeID, useThemeMode, type Skin } from "../theme";
import { THEMES_CHANGED_EVENT } from "../themeHost";
import classicShot from "../assets/skin-classic.jpg";
import tilesShot from "../assets/skin-tiles.jpg";

// 平台自带的“主题”应用：每个人在这里给自己选皮肤，选择存在自己的浏览器里。皮肤有内置的两种和管理员安装的主题包。
// 有“应用管理”权限的人还能上传主题包安装或升级，以及卸载主题。
// 主题包的格式见 docs/theme-spec.md，用 create-vibebooth-theme 生成。
export default function Themes({ me, themes }: { me: Me; themes: ThemeInfo[] }) {
  const { skin, setSkin } = useThemeMode();
  const canManage = hasPerm(me, "modules");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OperationResult | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  // 选用的主题被卸载了，按经典皮肤显示，这里也标经典为使用中。
  const current: Skin = themeID(skin) && !themes.some((t) => t.id === themeID(skin)) ? "classic" : skin;
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
    run(() => api.uninstallTheme(t.id), `${t.name} 已卸载，正在用它的人会换回经典皮肤。`);
  }

  return (
    <Flex vertical gap={16}>
      {result && <ResultAlert result={result} />}
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
                    {item.theme && <Tag>{item.theme.version}</Tag>}
                    {item.theme?.script && <Tag color="warning">带脚本</Tag>}
                  </Space>
                  <Typography.Text type="secondary">{item.description || " "}</Typography.Text>
                </Flex>
                <Space wrap>
                  {current === item.skin ? (
                    <Button icon={<CheckOutlined />} disabled>
                      使用中
                    </Button>
                  ) : (
                    <Button type="primary" onClick={() => setSkin(item.skin)}>
                      使用
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
}

type SkinItem = { skin: Skin; name: string; description: string; preview?: string; theme?: ThemeInfo };

// InstallTheme 是上传主题包的卡片，只给有“应用管理”权限的人看。
function InstallTheme({
  busy,
  run,
}: {
  busy: boolean;
  run: (action: () => Promise<{ log: string }>, success: string) => Promise<boolean>;
}) {
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
