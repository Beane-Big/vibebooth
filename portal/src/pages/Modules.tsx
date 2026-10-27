import { useEffect, useState } from "react";
import { Alert, Button, Card, Checkbox, Flex, List, Space, Tag, Typography } from "antd";
import { api, ApiError, privilegeInfo, type InstalledModule } from "../api";
import { PackageDragger, ResultAlert, type OperationResult } from "../components/PackageUpload";

// 应用管理：上传模块包安装或升级，卸载模块。安装和卸载都不会重启平台和其他应用。
export default function Modules() {
  const [modules, setModules] = useState<InstalledModule[] | null>(null);
  const [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  // 最近一次安装或卸载的结果和日志。
  const [result, setResult] = useState<OperationResult | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [purge, setPurge] = useState(false);
  // 模块声明了特权时，安装器先拒绝并列出特权，管理员确认后再带上 allowPrivileges 装一次。
  const [confirming, setConfirming] = useState<string[] | null>(null);

  function load() {
    api
      .modules()
      .then(setModules)
      .catch((err) => setError(err.message));
  }
  useEffect(load, []);

  async function run(action: () => Promise<{ log: string }>, success: string) {
    setBusy(true);
    setResult(null);
    try {
      const { log } = await action();
      setResult({ ok: true, message: success, log });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConfirming(err.privileges);
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

  function install(allowPrivileges = false) {
    if (!file) return;
    setConfirming(null);
    run(() => api.installModule(file, allowPrivileges), `${file.name} 已安装，几秒后出现在应用列表里。`).then(
      (done) => done && setFile(null),
    );
  }

  function uninstall(m: InstalledModule) {
    setRemoving(null);
    run(() => api.uninstallModule(m.id, purge), purge ? `${m.name} 已卸载，数据已删除。` : `${m.name} 已卸载，数据保留。`);
  }

  return (
    <Flex vertical gap={16}>
      <Card title="安装或升级应用">
        <Flex vertical gap={16}>
          <Typography.Text type="secondary">
            上传模块包（zip）：构建器构建出的软件包，或者在模块仓库里用 <code>npm run pack</code>{" "}
            生成的。已安装的应用会升级到包里的版本，数据保留。
          </Typography.Text>
          <PackageDragger
            file={file}
            onChange={(f) => {
              setFile(f);
              setConfirming(null);
            }}
            disabled={busy}
            text="点击或把模块包拖到这里"
          />
          <div>
            <Button type="primary" onClick={() => install()} disabled={!file} loading={busy}>
              {busy ? "处理中" : "安装"}
            </Button>
          </div>
          {busy && <Typography.Text type="secondary">正在导入镜像并启动，可能需要一两分钟。关掉页面也不会中断安装。</Typography.Text>}
          {confirming && (
            <Alert
              type="warning"
              showIcon
              message="这个应用需要以下特权，确认后才会安装"
              description={
                <Flex vertical gap={12}>
                  <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                    {confirming.map((p) => (
                      <li key={p}>
                        <code>{p}</code>：{privilegeInfo[p] ?? "平台不认识的特权"}
                      </li>
                    ))}
                  </ul>
                  <Space wrap>
                    <Button danger type="primary" onClick={() => install(true)} disabled={busy}>
                      确认并安装
                    </Button>
                    <Button onClick={() => setConfirming(null)}>取消</Button>
                  </Space>
                </Flex>
              }
            />
          )}
        </Flex>
      </Card>

      {result && <ResultAlert result={result} />}

      <Card title="已安装的应用">
        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
        <List
          loading={modules === null && !error}
          dataSource={modules ?? []}
          locale={{ emptyText: "还没有安装任何应用。" }}
          renderItem={(m) => (
            <List.Item>
              <Flex justify="space-between" align="center" gap={12} wrap style={{ width: "100%" }}>
                <Flex vertical gap={4} style={{ minWidth: 200, flex: 1 }}>
                  <Space size={8} wrap>
                    <Typography.Text strong>{m.name}</Typography.Text>
                    <Tag>{m.version}</Tag>
                    {!m.healthy && <Tag color="error">不可用</Tag>}
                  </Space>
                  <Typography.Text type="secondary">
                    {m.id}
                    {m.requires.length > 0 && ` · 依赖 ${m.requires.join("、")}`}
                    {m.optional.length > 0 && ` · 可选依赖 ${m.optional.join("、")}`}
                    {m.privileges.length > 0 && ` · 特权 ${m.privileges.join("、")}`}
                    {m.requiredBy.length > 0 && ` · 被 ${m.requiredBy.join("、")} 依赖`}
                  </Typography.Text>
                </Flex>
                {removing === m.id ? (
                  <Space wrap>
                    <Checkbox checked={purge} onChange={(e) => setPurge(e.target.checked)}>
                      同时删除数据（无法恢复）
                    </Checkbox>
                    <Button danger type="primary" onClick={() => uninstall(m)} disabled={busy}>
                      确认卸载
                    </Button>
                    <Button onClick={() => setRemoving(null)}>取消</Button>
                  </Space>
                ) : (
                  <Button
                    disabled={busy || m.requiredBy.length > 0}
                    title={m.requiredBy.length > 0 ? `请先卸载 ${m.requiredBy.join("、")}` : undefined}
                    onClick={() => {
                      setPurge(false);
                      setRemoving(m.id);
                    }}
                  >
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
