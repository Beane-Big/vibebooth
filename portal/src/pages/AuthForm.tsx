import { useEffect, useState } from "react";
import { Alert, Button, Checkbox, ConfigProvider, Form, Input, Progress, theme, type InputProps } from "antd";
import { CheckOutlined, EyeInvisibleOutlined, EyeOutlined } from "@ant-design/icons";
import liquidBg from "../assets/liquid-bg.jpg";
import { api, ApiError, type Me } from "../api";
import Beian from "../components/Beian";
import { confirmRules } from "../password";
import "./Auth.css";

type Mode = "login" | "register" | "complete";
type Fields = { username: string; email?: string; password: string; confirm?: string; remember?: boolean };
const titles = { login: "登录 Vibebooth", register: "创建 Vibebooth 账号", complete: "注册完成" };
const required = (message: string) => ({ required: true, message });
const emailRule = { type: "email" as const, message: "请输入有效的邮箱地址" };
const usernameRules = [required("请输入账号"), {
  pattern: /^[a-zA-Z0-9_.-]{2,32}$/, message: "账号须为 2–32 位字母、数字、下划线、点或连字符",
}];
const passwordRules = [required("请输入密码"), {
  validator: (_: unknown, value?: string) => !value || ([...value].length >= 8 && new TextEncoder().encode(value).length <= 72)
    ? Promise.resolve() : Promise.reject(new Error("至少 8 个字符，最多 72 字节")),
}];

function PasswordField(props: InputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <Input
      {...props}
      type={visible ? "text" : "password"}
      suffix={
        <Button type="text" size="small" aria-label={visible ? "隐藏密码" : "显示密码"}
          onClick={() => setVisible(!visible)} icon={visible ? <EyeOutlined /> : <EyeInvisibleOutlined />} />
      }
    />
  );
}

function AuthForm({ onLogin }: { onLogin: (user: Me) => void }) {
  const [mode, setMode] = useState<Mode>("login");
  const [policies, setPolicies] = useState({ terms: "", privacy: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<Fields>();
  const watched = Form.useWatch("password", form) ?? "";
  const strength = Math.min(3, Number(watched.length >= 8) + Number(watched.length >= 12) + Number(/[\p{L}]/u.test(watched) && /[^\p{L}]/u.test(watched)));

  useEffect(() => { api.authOptions().then(setPolicies).catch(() => {}); }, []);

  function go(next: Mode) {
    setMode(next);
    setError("");
    form.resetFields();
  }

  async function submit(values: Fields) {
    setError("");
    setBusy(true);
    try {
      if (mode === "login") {
        onLogin(await api.login(values.username, values.password, values.remember === true));
      } else if (mode === "register") {
        await api.register({ username: values.username, email: values.email, password: values.password });
        go("complete");
      }
    } catch (err) {
      setError(mode === "login" && err instanceof ApiError && err.status === 401
        ? "账号或密码不正确，请检查后重试。"
        : err instanceof Error ? err.message : "操作失败，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <div className="auth-backdrop" aria-hidden="true">
        <img src={liquidBg} alt="" width={1920} height={1200} />
        <span /><span /><span /><span /><span />
      </div>
      <section className="auth-card" aria-labelledby="auth-title">
        <header className={mode === "complete" ? "auth-heading auth-success" : "auth-heading"}>
          {mode === "complete" && <span className="auth-success-mark" aria-hidden="true"><CheckOutlined /></span>}
          <h1 id="auth-title" role={mode === "complete" ? "status" : undefined}>{titles[mode]}</h1>
          {mode === "login" && (
            <p className="auth-signup">还没有账号？<Button type="link" disabled={busy} onClick={() => go("register")}>注册账号</Button></p>
          )}
        </header>
        {mode === "complete" ? (
          <Button block type="primary" size="large" onClick={() => go("login")}>返回登录</Button>
        ) : (
          <Form form={form} layout="vertical" requiredMark={false} disabled={busy} onFinish={submit}>
            <Form.Item name="username" label="账号"
              rules={mode === "register" ? usernameRules : [required("请输入账号")]}>
              <Input size="large" autoComplete="username" autoCapitalize="none" spellCheck={false} />
            </Form.Item>
            {mode === "register" && (
              <Form.Item name="email" label="邮箱（选填）" rules={[emailRule]}>
                <Input size="large" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} />
              </Form.Item>
            )}
            <Form.Item name="password" label="密码" rules={mode === "login" ? [required("请输入密码")] : passwordRules}>
              <PasswordField key={mode} size="large" placeholder="输入密码" autoComplete={mode === "login" ? "current-password" : "new-password"} />
            </Form.Item>
            {mode === "register" && (
              <>
                <Progress aria-label="密码强度" percent={strength * 100 / 3} showInfo={false} strokeColor="#535b9f" />
                <Form.Item name="confirm" label="确认密码" dependencies={["password"]} rules={confirmRules}>
                  <PasswordField size="large" autoComplete="new-password" />
                </Form.Item>
              </>
            )}
            {mode === "login" && (
              <div className="auth-actions">
                <Form.Item name="remember" valuePropName="checked"><Checkbox>记住登录状态</Checkbox></Form.Item>
              </div>
            )}
            {error && <Alert type="error" showIcon message={error} role="alert" />}
            <Button block type="primary" size="large" htmlType="submit" loading={busy}>
              {mode === "login" ? "登录" : "创建账号"}
            </Button>
            {mode === "login" && (
              <Button block size="large" href="/" disabled={busy} className="auth-browse">随便看看</Button>
            )}
          </Form>
        )}
        {mode === "register" && (
          <nav className="auth-nav" aria-label="账号入口">
            <Button type="link" disabled={busy} onClick={() => go("login")}>返回登录</Button>
          </nav>
        )}
      </section>
      <footer className="auth-footer">
        {(policies.terms || policies.privacy) && (
          <nav className="auth-policy" aria-label="站点政策">
            {policies.terms && <a href={policies.terms} target="_blank" rel="noreferrer">服务条款</a>}
            {policies.privacy && <a href={policies.privacy} target="_blank" rel="noreferrer">隐私声明</a>}
          </nav>
        )}
        <Beian />
      </footer>
    </main>
  );
}

export default function Login(props: { onLogin: (user: Me) => void }) {
  return (
    <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: "#245ed0", colorText: "#18233a", borderRadius: 16, colorBorder: "#aac0dc" } }}>
      <AuthForm {...props} />
    </ConfigProvider>
  );
}
