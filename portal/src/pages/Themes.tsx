import { useEffect, useState } from "react";
import { Alert, Button, Card, Flex, List, Space, Tag, Typography } from "antd";
import { api, ApiError, type ThemeInfo } from "../api";
import { PackageDragger, ResultAlert, type OperationResult } from "../components/PackageUpload";
import { THEMES_CHANGED_EVENT } from "../themeHost";

// 主题管理：上传主题包安装或升级，卸载主题。装好的主题所有人都能在头像菜单的“皮肤”里选用。
// 主题包的格式见 docs/theme-spec.md，用 create-vibebooth theme 生成。
export default function Themes() {
  const [themes, setThemes] = useState<ThemeInfo[] | null>(null);
  const [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OperationResult | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // 主题带脚本时，安装器先拒绝，管理员确认后再带上 allowScript 装一次。
  const [confirming, setConfirming] = useState(false);

  function load() {
    api
      .themes()
      .then(setThemes)
      .catch((err) => setError(err.message));
  }
  useEffect(load, []);

  async function run(action: () => Promise<{ log: string }>, success: string) {
    setBusy(true);
    setResult(null);
    try {
      const { log } = await action();
      setResult({ ok: true, message: success, log });
      window.dispatchEvent(new Event(THEMES_CHANGED_EVENT));
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConfirming(true);
        return false;
      }
      const log = err instanceof ApiError ? err.log : "";
      setResult({ ok: false, message: err instanceof Error ? err.message : "操作失败", log });
      return false;
    } finally {
      setBusy(false);
      load();
    }
  }

  function install(allowScript = false) {
    if (!file) return;
    setConfirming(false);
    run(() => api.installTheme(file, allowScript), `${file.name} 已安装，在头像菜单的“皮肤”里选用。`).then(
      (done) => done && setFile(null),
    );
  }

  function uninstall(t: ThemeInfo) {
    setRemoving(null);
    run(() => api.uninstallTheme(t.id), `${t.name} 已卸载，正在用它的人会换回经典皮肤。`);
  }

  return (
    <Flex vertical gap={16}>
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

      {result && <ResultAlert result={result} />}

      <Card title="已安装的主题">
        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
        <List
          loading={themes === null && !error}
          dataSource={themes ?? []}
          locale={{ emptyText: "还没有安装任何主题，现在可选的是内置的经典和彩色方块。" }}
          renderItem={(t) => (
            <List.Item>
              <Flex justify="space-between" align="center" gap={12} wrap style={{ width: "100%" }}>
                <Flex gap={12} align="center" style={{ minWidth: 200, flex: 1 }}>
                  {t.preview && (
                    <img className="theme-preview" src={`/api/platform/themes/${t.id}/${t.preview}?v=${t.version}`} alt="" />
                  )}
                  <Flex vertical gap={4} style={{ minWidth: 0 }}>
                    <Space size={8} wrap>
                      <Typography.Text strong>{t.name}</Typography.Text>
                      <Tag>{t.version}</Tag>
                      {t.script && <Tag color="warning">带脚本</Tag>}
                    </Space>
                    <Typography.Text type="secondary">
                      {t.id}
                      {t.description && ` · ${t.description}`}
                    </Typography.Text>
                  </Flex>
                </Flex>
                {removing === t.id ? (
                  <Space wrap>
                    <Button danger type="primary" onClick={() => uninstall(t)} disabled={busy}>
                      确认卸载
                    </Button>
                    <Button onClick={() => setRemoving(null)}>取消</Button>
                  </Space>
                ) : (
                  <Button disabled={busy} onClick={() => setRemoving(t.id)}>
                    卸载
                  </Button>
                )}
              </Flex>
            </List.Item>
          )}
        />
      </Card>
    </Flex>
  );
}
