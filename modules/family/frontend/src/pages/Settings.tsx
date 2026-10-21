import { useState } from "react";
import { api } from "../api";

// 家庭优化大师的设置页，从门户“设置”页进入；修改类操作由后端检查管理员角色。
export default function Settings() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function reset() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.reset();
      setMessage("所有人的分数已清零。");
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="topbar">
        <a className="back" href="/settings">
          ← 返回设置
        </a>
        <span className="title">家庭优化大师 · 设置</span>
      </header>
      <main className="content stack">
        <section className="card stack">
          <h1>分数清零</h1>
          <p className="muted">把所有人的分数归零，无法撤销。人员名单和照片在“人员管理”里维护，不受影响。</p>
          <div className="actions">
            {confirming ? (
              <>
                <span>真的要清零吗？</span>
                <button className="danger" onClick={reset} disabled={busy}>
                  清零
                </button>
                <button className="link" onClick={() => setConfirming(false)} disabled={busy}>
                  不了
                </button>
              </>
            ) : (
              <button className="danger" onClick={() => setConfirming(true)}>
                分数清零
              </button>
            )}
          </div>
          {message && <p className="muted">{message}</p>}
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    </>
  );
}
