import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, privilegeInfo, type InstalledModule } from "../api";

// 应用管理：上传模块包安装或升级，卸载模块。安装和卸载都不会重启平台和其他应用。
export default function Modules() {
  const [modules, setModules] = useState<InstalledModule[] | null>(null);
  const [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  // 装完后换一个 key，让文件选择框清空。
  const [fileKey, setFileKey] = useState(0);
  const [busy, setBusy] = useState(false);
  // 最近一次安装或卸载的结果和日志。
  const [result, setResult] = useState<{ ok: boolean; message: string; log: string } | null>(null);
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

  function install(e: FormEvent | null, allowPrivileges = false) {
    e?.preventDefault();
    if (!file) return;
    setConfirming(null);
    run(() => api.installModule(file, allowPrivileges), `${file.name} 已安装，几秒后出现在应用列表里。`).then(
      (done) => {
        if (!done) return;
        setFile(null);
        setFileKey((k) => k + 1);
      },
    );
  }

  function uninstall(m: InstalledModule) {
    setRemoving(null);
    run(() => api.uninstallModule(m.id, purge), purge ? `${m.name} 已卸载，数据已删除。` : `${m.name} 已卸载，数据保留。`);
  }

  return (
    <div className="stack">
      <form className="card section" onSubmit={install}>
        <h2>安装或升级应用</h2>
        <p className="muted">
          上传在模块仓库里用 <code>npm run pack</code> 生成的模块包（zip）。已安装的应用会升级到包里的版本，数据保留。
        </p>
        <div className="row">
          <input
            key={fileKey}
            type="file"
            accept=".zip"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setConfirming(null);
            }}
            disabled={busy}
          />
          <button type="submit" disabled={!file || busy}>
            {busy ? "处理中…" : "安装"}
          </button>
        </div>
        {busy && <p className="muted">正在导入镜像并启动，可能需要一两分钟。关掉页面也不会中断安装。</p>}
        {confirming && (
          <div className="stack">
            <p className="error">这个应用需要以下特权，确认后才会安装：</p>
            <ul>
              {confirming.map((p) => (
                <li key={p}>
                  <code>{p}</code>：{privilegeInfo[p] ?? "平台不认识的特权"}
                </li>
              ))}
            </ul>
            <div className="row">
              <button type="button" className="danger" onClick={() => install(null, true)} disabled={busy}>
                确认并安装
              </button>
              <button type="button" className="secondary" onClick={() => setConfirming(null)}>
                取消
              </button>
            </div>
          </div>
        )}
      </form>

      {result && (
        <div className="card section">
          <p className={result.ok ? "success" : "error"}>{result.message}</p>
          {result.log && (
            <details open={!result.ok}>
              <summary className="muted">日志</summary>
              <pre className="log">{result.log}</pre>
            </details>
          )}
        </div>
      )}

      <div className="card section">
        <h2>已安装的应用</h2>
        {error && <p className="error">{error}</p>}
        {modules && modules.length === 0 && <p className="muted">还没有安装任何应用。</p>}
        <ul className="list">
          {modules?.map((m) => (
            <li key={m.id} className="list-item">
              <div className="list-main">
                <span className="app-name">
                  {m.name}
                  <span className="tag">{m.version}</span>
                  {!m.healthy && <span className="badge">不可用</span>}
                </span>
                <span className="muted">
                  {m.id}
                  {m.requires.length > 0 && ` · 依赖 ${m.requires.join("、")}`}
                  {m.optional.length > 0 && ` · 可选依赖 ${m.optional.join("、")}`}
                  {m.privileges.length > 0 && ` · 特权 ${m.privileges.join("、")}`}
                  {m.requiredBy.length > 0 && ` · 被 ${m.requiredBy.join("、")} 依赖`}
                </span>
              </div>
              {removing === m.id ? (
                <div className="row">
                  <label className="checkbox">
                    <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
                    同时删除数据（无法恢复）
                  </label>
                  <button className="danger" onClick={() => uninstall(m)} disabled={busy}>
                    确认卸载
                  </button>
                  <button className="secondary" onClick={() => setRemoving(null)}>
                    取消
                  </button>
                </div>
              ) : (
                <button
                  className="secondary"
                  disabled={busy || m.requiredBy.length > 0}
                  title={m.requiredBy.length > 0 ? `请先卸载 ${m.requiredBy.join("、")}` : undefined}
                  onClick={() => {
                    setPurge(false);
                    setRemoving(m.id);
                  }}
                >
                  卸载
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
