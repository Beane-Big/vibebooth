import { useEffect, useState } from "react";
import { Alert, Button, Card, Checkbox, Flex, List, Progress, Space, Tag, Typography } from "antd";
import { api, ApiError, maxPackageMB, privilegeInfo, type InstalledModule } from "../api";
import { LogCollapse, PackagesDragger, ResultAlert, type OperationResult } from "../components/PackageUpload";

// 排队安装的一个模块包。confirm 表示模块声明了特权，等管理员确认；确认后带上 allowPrivileges 重新排队。
type QueueStatus = "waiting" | "uploading" | "installing" | "done" | "failed" | "confirm";
type QueueItem = {
  key: number;
  file: File;
  status: QueueStatus;
  // 上传进度（0～1）。
  progress: number;
  message: string;
  log: string;
  privileges: string[];
  allowPrivileges: boolean;
};

const statusTag: Record<QueueStatus, { color?: string; text: string }> = {
  waiting: { text: "排队中" },
  uploading: { color: "processing", text: "上传中" },
  installing: { color: "processing", text: "安装中" },
  done: { color: "success", text: "已安装" },
  failed: { color: "error", text: "失败" },
  confirm: { color: "warning", text: "待确认特权" },
};

let nextKey = 1;

// 应用管理：上传模块包安装或升级，卸载模块。安装和卸载都不会重启平台和其他应用。
// 一次可以选多个模块包，按加入的顺序一个一个上传、安装：安装器同一时间只装一个，一起传也只是排队，还会抢带宽。
export default function Modules() {
  const [modules, setModules] = useState<InstalledModule[] | null>(null);
  const [error, setError] = useState("");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  // 正在按顺序安装队列；装完最后一个排队的包后自动停下。
  const [running, setRunning] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  // 最近一次卸载的结果和日志。安装的结果显示在队列里每个包的下面。
  const [result, setResult] = useState<OperationResult | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [purge, setPurge] = useState(false);
  const busy = running || uninstalling;

  function load() {
    api
      .modules()
      .then(setModules)
      .catch((err) => setError(err.message));
  }
  useEffect(load, []);

  function patch(key: number, change: Partial<QueueItem>) {
    setQueue((q) => q.map((it) => (it.key === key ? { ...it, ...change } : it)));
  }

  // 同一个文件已经在队列里、还没装好时不重复加。超过大小上限的在浏览器里就标成失败，不用传完才被拒。
  function add(files: File[]) {
    setResult(null);
    setQueue((q) => {
      const same = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
      const fresh = files.filter((f) => !q.some((it) => it.status !== "done" && same(it.file, f)));
      return [
        ...q,
        ...fresh.map((file): QueueItem => {
          const tooLarge = file.size > maxPackageMB * 1024 * 1024;
          return {
            key: nextKey++,
            file,
            status: tooLarge ? "failed" : "waiting",
            progress: 0,
            message: tooLarge ? `模块包不能超过 ${maxPackageMB} MB` : "",
            log: "",
            privileges: [],
            allowPrivileges: false,
          };
        }),
      ];
    });
  }

  // 队列在跑、手上没有正在装的包时，取下一个排队的包；没有了就停下。
  useEffect(() => {
    if (!running || queue.some((it) => it.status === "uploading" || it.status === "installing")) return;
    const next = queue.find((it) => it.status === "waiting");
    if (!next) {
      setRunning(false);
      return;
    }
    install(next);
  }, [running, queue]);

  async function install(item: QueueItem) {
    patch(item.key, { status: "uploading", progress: 0, message: "", log: "" });
    try {
      const { log } = await api.installModule(item.file, item.allowPrivileges, (f) =>
        patch(item.key, f < 1 ? { progress: f } : { progress: 1, status: "installing" }),
      );
      patch(item.key, { status: "done", message: "已安装，几秒后出现在应用列表里。", log });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        patch(item.key, { status: "confirm", privileges: err.privileges });
      } else {
        const log = err instanceof ApiError ? err.log : "";
        patch(item.key, { status: "failed", message: err instanceof Error ? err.message : "安装失败", log });
      }
    } finally {
      load();
    }
  }

  // 重新排队：失败后重试，或者确认特权后带上 allowPrivileges 再装。队列已经停下时重新开始。
  function requeue(item: QueueItem, allowPrivileges = item.allowPrivileges) {
    patch(item.key, { status: "waiting", allowPrivileges, message: "", log: "" });
    setRunning(true);
  }

  async function uninstall(m: InstalledModule) {
    setRemoving(null);
    setUninstalling(true);
    setResult(null);
    try {
      const { log } = await api.uninstallModule(m.id, purge);
      setResult({ ok: true, message: purge ? `${m.name} 已卸载，数据已删除。` : `${m.name} 已卸载，数据保留。`, log });
    } catch (err) {
      const log = err instanceof ApiError ? err.log : "";
      setResult({ ok: false, message: err instanceof Error ? err.message : "操作失败", log });
    } finally {
      setUninstalling(false);
      load();
    }
  }

  const waiting = queue.filter((it) => it.status === "waiting").length;
  const finished = queue.filter((it) => it.status === "done").length;

  return (
    <Flex vertical gap={16}>
      <Card title="安装或升级应用">
        <Flex vertical gap={16}>
          <Typography.Text type="secondary">
            上传模块包（zip）：构建器构建出的软件包，或者在模块仓库里用 <code>npm run pack</code>{" "}
            生成的。已安装的应用会升级到包里的版本，数据保留。可以一次选多个，按列表顺序一个一个安装；有依赖的应用，把它依赖的应用排在前面。
          </Typography.Text>
          <PackagesDragger onAdd={add} text="点击或把模块包拖到这里，可以多选" />
          {queue.length > 0 && (
            <List
              size="small"
              bordered
              dataSource={queue}
              renderItem={(it) => (
                <List.Item>
                  <QueueRow
                    item={it}
                    uninstalling={uninstalling}
                    onRetry={() => requeue(it)}
                    onConfirm={() => requeue(it, true)}
                    onRemove={() => setQueue((q) => q.filter((x) => x.key !== it.key))}
                  />
                </List.Item>
              )}
            />
          )}
          {queue.length > 0 && (
            <Space wrap>
              <Button
                type="primary"
                onClick={() => setRunning(true)}
                disabled={running || waiting === 0 || uninstalling}
                loading={running}
              >
                {running ? "安装中" : waiting > 1 ? `安装（${waiting} 个）` : "安装"}
              </Button>
              <Button onClick={() => setQueue((q) => q.filter((it) => it.status !== "done"))} disabled={finished === 0}>
                清除已安装的
              </Button>
            </Space>
          )}
          {running && (
            <Typography.Text type="secondary">
              上传中的包传完之前不要关掉页面。已经开始安装的包关掉页面也会装完，但排在后面的包不会再装。
            </Typography.Text>
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

// QueueRow 是队列里的一个模块包：文件名、状态、上传进度、结果和日志，以及按状态能做的操作。
function QueueRow({
  item,
  uninstalling,
  onRetry,
  onConfirm,
  onRemove,
}: {
  item: QueueItem;
  // 正在卸载时不能重试或确认安装，和卸载时不能点“安装”一样。
  uninstalling: boolean;
  onRetry: () => void;
  onConfirm: () => void;
  onRemove: () => void;
}) {
  const tag = statusTag[item.status];
  const active = item.status === "uploading" || item.status === "installing";
  return (
    <Flex vertical gap={8} style={{ width: "100%" }}>
      <Flex justify="space-between" align="center" gap={12} wrap>
        <Flex vertical gap={4} style={{ minWidth: 200, flex: 1 }}>
          <Space size={8} wrap>
            <Typography.Text strong>{item.file.name}</Typography.Text>
            <Tag color={tag.color}>{tag.text}</Tag>
          </Space>
          <Typography.Text type="secondary">
            {formatSize(item.file.size)}
            {item.status === "installing" && " · 正在导入镜像并启动，可能需要一两分钟"}
            {item.message && ` · ${item.message}`}
          </Typography.Text>
        </Flex>
        <Space wrap>
          {item.status === "failed" && item.file.size <= maxPackageMB * 1024 * 1024 && (
            <Button size="small" onClick={onRetry} disabled={uninstalling}>
              重试
            </Button>
          )}
          {!active && item.status !== "confirm" && (
            <Button size="small" onClick={onRemove}>
              移除
            </Button>
          )}
        </Space>
      </Flex>
      {item.status === "uploading" && <Progress percent={Math.floor(item.progress * 100)} size="small" />}
      {item.status === "confirm" && (
        <Alert
          type="warning"
          showIcon
          message="这个应用需要以下特权，确认后才会安装"
          description={
            <Flex vertical gap={12}>
              <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                {item.privileges.map((p) => (
                  <li key={p}>
                    <code>{p}</code>：{privilegeInfo[p] ?? "平台不认识的特权"}
                  </li>
                ))}
              </ul>
              <Space wrap>
                <Button danger type="primary" onClick={onConfirm} disabled={uninstalling}>
                  确认并安装
                </Button>
                <Button onClick={onRemove}>不装了</Button>
              </Space>
            </Flex>
          }
        />
      )}
      {item.log && <LogCollapse log={item.log} open={item.status === "failed"} />}
    </Flex>
  );
}

function formatSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
