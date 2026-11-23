import { Alert, Button, Card, Input, InputNumber, Typography } from "antd";
import { useEffect, useState, type FormEvent } from "react";
import { api, type BuildArg, type Settings as SettingsData } from "./api";
import { ArrowLeftOutlined } from "@ant-design/icons";

// 构建器的设置页，从首页右上角的“设置”进入，左上角“构建记录”回首页；保存时由后端检查“设置”菜单权限。
export default function Settings({ onBack }: { onBack: () => void }) {
  const [form, setForm] = useState<SettingsData | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .settings()
      .then(setForm)
      .catch((err) => setError(err.message));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    // 输入框限制显示精度，保存时再检查实际状态，避免小数或越界值进入整数接口。
    setError("");
    setMessage("");
    const limits = [
      { value: form.maxPackages, max: 50, label: "每个应用保留的软件包数" },
      { value: form.maxDays, max: 365, label: "保留天数" },
      { value: form.cacheGB, max: 100, label: "构建缓存上限（GB）" },
    ];
    const invalid = limits.find(
      ({ value, max }) => !Number.isInteger(value) || value < 1 || value > max,
    );
    if (invalid) {
      setError(`${invalid.label}必须是 1 到 ${invalid.max} 之间的整数`);
      return;
    }
    setBusy(true);
    try {
      setForm(await api.saveSettings(form));
      setMessage("已保存，下一次构建开始生效。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  const set = (patch: Partial<SettingsData>) =>
    form && setForm({ ...form, ...patch });
  const setArg = (i: number, patch: Partial<BuildArg>) =>
    form &&
    set({
      buildArgs: form.buildArgs.map((a, k) =>
        k === i ? { ...a, ...patch } : a,
      ),
    });

  return (
    <section className="builder-page">
      <div className="page-head">
        <Button onClick={onBack} icon={<ArrowLeftOutlined />}>
          构建记录
        </Button>
        <Typography.Title level={5} style={{ margin: 0 }}>
          设置
        </Typography.Title>
      </div>
      {!form &&
        (error ? (
          <Alert type="error" showIcon message={<>{error}</>} />
        ) : (
          <Typography.Text type="secondary">加载中…</Typography.Text>
        ))}
      {form && (
        <form className="stack" onSubmit={save}>
          <Card title="保留规则">
            <div className="stack">
              <Typography.Text type="secondary">
                每次构建完和每小时检查一次，超出的构建记录连同软件包一起删除。成功和失败的记录分别计数。
              </Typography.Text>
              <label className="field">
                每个应用保留最近几个软件包
                <InputNumber
                  style={{ width: "100%" }}
                  precision={0}
                  step={1}
                  min={1}
                  max={50}
                  value={form.maxPackages}
                  onChange={(value) => set({ maxPackages: value ?? 1 })}
                />
              </label>
              <label className="field">
                最多保留几天
                <InputNumber
                  style={{ width: "100%" }}
                  precision={0}
                  step={1}
                  min={1}
                  max={365}
                  value={form.maxDays}
                  onChange={(value) => set({ maxDays: value ?? 1 })}
                />
              </label>
              <label className="field">
                构建缓存上限（GB）
                <Typography.Text type="secondary">
                  下载过的依赖和没变的构建步骤会缓存起来，下次构建更快；超过上限时先清理最久没用的。
                </Typography.Text>
                <InputNumber
                  style={{ width: "100%" }}
                  precision={0}
                  step={1}
                  min={1}
                  max={100}
                  value={form.cacheGB}
                  onChange={(value) => set({ cacheGB: value ?? 1 })}
                />
              </label>
            </div>
          </Card>
          <Card title="构建参数">
            <div className="stack">
              <Typography.Text type="secondary">
                按服务器的网络填写，比如国内的镜像源。构建时构建器读每个应用的
                Dockerfile，只把其中用 <code>ARG</code>{" "}
                声明了的参数传过去，没填的用 Dockerfile
                里的默认值；构建日志里会列出每个参数传了什么。应用需要哪些参数看应用的说明，常见的有{" "}
                <code>NPM_REGISTRY</code>（如 https://registry.npmmirror.com）、
                <code>GOPROXY</code>（如 https://goproxy.cn,direct）。
              </Typography.Text>
              {form.buildArgs.map((a, i) => (
                <div className="arg-row" key={i}>
                  <Input
                    value={a.name}
                    placeholder="参数名，例如 NPM_REGISTRY"
                    aria-label="参数名"
                    onChange={(e) => setArg(i, { name: e.target.value })}
                  />
                  <Input
                    value={a.value}
                    placeholder="值"
                    aria-label="值"
                    onChange={(e) => setArg(i, { value: e.target.value })}
                  />
                  <Button
                    type="link"
                    danger
                    onClick={() =>
                      set({
                        buildArgs: form.buildArgs.filter((_, k) => k !== i),
                      })
                    }
                  >
                    删除
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  onClick={() =>
                    set({
                      buildArgs: [...form.buildArgs, { name: "", value: "" }],
                    })
                  }
                >
                  添加参数
                </Button>
              </div>
            </div>
          </Card>
          <div className="actions">
            <Button
              type="primary"
              loading={busy}
              htmlType="submit"
              disabled={busy}
            >
              {busy ? "保存中…" : "保存"}
            </Button>
            {message && <Alert type="success" showIcon message={message} />}
            {error && <Alert type="error" showIcon message={error} />}
          </div>
        </form>
      )}
    </section>
  );
}
