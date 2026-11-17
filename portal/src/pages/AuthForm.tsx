import { useEffect, useState } from "react";
import { Alert, Button, Checkbox, ConfigProvider, Form, Input, Progress, theme, type InputProps } from "antd";
import { CheckOutlined, EyeInvisibleOutlined, EyeOutlined, GoogleOutlined } from "@ant-design/icons";
import liquidBg from "../assets/liquid-bg.jpg";
import { api, ApiError, type Me } from "../api";
import Beian from "../components/Beian";
import { confirmRules } from "../password";
import "./Auth.css";

type Mode = "login" | "register" | "reset";
type Fields = { email: string; password: string; code: string; displayName: string; remember: boolean; accepted: boolean };
const titles = { login: "登录 Vibebooth", register: "创建 Vibebooth 账号", reset: "重置密码" };
const optionsDefault = { register: false, reset: false, google: false, terms: "", privacy: "" };
const required = (message: string) => ({ required: true, message });
const emailRules = [required("请输入邮箱"), { type: "email" as const, message: "请输入有效的邮箱地址" }];
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
  const [options, setOptions] = useState(optionsDefault);
  const [step, setStep] = useState(0);
  const [accountLogin, setAccountLogin] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(() => new URLSearchParams(location.search).has("google_error") ? "Google 登录未完成。请重试，或使用已验证的邮箱登录。" : "");
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<Fields>();
  const watched = Form.useWatch("password", form) ?? "";
  const strength = Math.min(3, Number(watched.length >= 8) + Number(watched.length >= 12) + Number(/[\p{L}]/u.test(watched) && /[^\p{L}]/u.test(watched)));

  useEffect(() => { api.authOptions().then(setOptions).catch(() => {}); }, []);

  function go(next: Mode) {
    setMode(next);
    setStep(0);
    setError("");
    setEmail("");
    setCode("");
    setPassword("");
    form.resetFields();
  }

  async function submit(values: Fields) {
    setError("");
    setBusy(true);
    try {
      if (mode === "login") {
        onLogin(await api.login(values.email, values.password, values.remember === true));
      } else if (step === 0) {
        const address = values.email.trim();
        await api.sendCode(mode, address);
        setEmail(address);
        setPassword(values.password ?? "");
        setStep(1);
      } else if (step === 1) {
        await api.verifyCode(mode, email, values.code);
        setCode(values.code);
        setStep(2);
      } else {
        await api.emailAuth(mode, { email, code, password: mode === "register" ? password : values.password, displayName: values.displayName, accepted: values.accepted });
        setPassword("");
        setCode("");
        setStep(3);
      }
    } catch (err) {
      setError(mode === "login" && err instanceof ApiError && err.status === 401
        ? "邮箱、用户名或密码不正确，请检查后重试。"
        : err instanceof Error ? err.message : "操作失败，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  const steps = mode === "register" ? ["账号", "验证", "资料", "完成"] : ["邮箱", "验证", "新密码", "完成"];
  const heading = mode === "login" || step === 0 ? titles[mode]
    : step === 1 ? (mode === "register" ? "验证你的邮箱" : "验证身份")
    : step === 2 ? (mode === "register" ? "完善个人资料" : "设置新密码")
    : mode === "register" ? "注册完成" : "密码已重置";
  return (
    <main className="auth-shell">
      <div className="auth-backdrop" aria-hidden="true">
        <img src={liquidBg} alt="" width={1920} height={1200} />
        <span /><span /><span /><span /><span />
      </div>
      <section className="auth-card" aria-labelledby="auth-title">
        {mode !== "login" && step < 3 && (
          <ol className="auth-steps" aria-label="认证进度">
            {steps.map((label, index) => (
              <li key={label} aria-current={index === step ? "step" : undefined} data-completed={index < step}>
                <span aria-hidden="true" />{index + 1}. {label}
              </li>
            ))}
          </ol>
        )}
        <header className={step === 3 ? "auth-heading auth-success" : "auth-heading"}>
          {step === 3 && <span className="auth-success-mark" aria-hidden="true"><CheckOutlined /></span>}
          <h1 id="auth-title">{heading}</h1>
          {mode === "login" && options.register && (
            <p className="auth-signup">还没有账号？<Button type="link" disabled={busy} onClick={() => go("register")}>注册账号</Button></p>
          )}
        </header>
        {mode !== "login" && step === 3 ? (
          <>
            <p className="auth-success-copy" role="status">{mode === "register" ? "账号创建成功，可以登录了。" : "请使用新密码登录。"}</p>
            <Button block type="primary" size="large" onClick={() => go("login")}>返回登录</Button>
          </>
        ) : (
          <Form form={form} layout="vertical" requiredMark={false} disabled={busy} onFinish={submit}>
            {(mode === "login" || step === 0) && (
              <Form.Item name="email" label={mode === "login" && accountLogin ? "账号" : "邮箱"} rules={mode === "login" && accountLogin ? [required("请输入账号")] : emailRules}>
                <Input size="large" type={mode === "login" && accountLogin ? "text" : "email"} autoComplete={mode === "login" && accountLogin ? "username" : "email"} autoCapitalize="none" spellCheck={false} />
              </Form.Item>
            )}
            {(mode === "login" || (mode === "register" && step === 0) || (mode === "reset" && step === 2)) && (
              <>
                <div className="auth-password-row">
                  <Form.Item name="password" label={mode === "reset" ? "新密码" : "密码"} rules={mode === "login" ? [required("请输入密码")] : passwordRules}>
                    <PasswordField key={mode} size="large" placeholder="输入密码" autoComplete={mode === "login" ? "current-password" : "new-password"} />
                  </Form.Item>
                  {mode === "login" && options.reset && <Button className="auth-forgot" type="link" onClick={() => go("reset")}>忘记密码？</Button>}
                </div>
                {mode !== "login" && (
                  <>
                    <p className="auth-caption">至少 8 个字符，最多 72 字节。建议使用较长的密码。</p>
                    <Progress aria-label="密码强度" percent={strength * 100 / 3} showInfo={false} strokeColor="#535b9f" />
                    <Form.Item name="confirm" label="确认密码" dependencies={["password"]} rules={confirmRules}>
                      <PasswordField size="large" autoComplete="new-password" />
                    </Form.Item>
                  </>
                )}
              </>
            )}
            {mode === "login" && (
              <div className="auth-actions">
                <Form.Item name="remember" valuePropName="checked"><Checkbox>记住登录状态</Checkbox></Form.Item>
              </div>
            )}
            {mode !== "login" && step === 1 && (
              <>
                <Alert type="info" showIcon message={mode === "reset" ? "如果该邮箱已注册，你会收到重置说明。" : "如果该邮箱可注册，你会收到验证码。"} description={email} />
                <Form.Item name="code" label="邮箱验证码" rules={[required("请输入验证码"), { pattern: /^[a-fA-F0-9]{12}$/, message: "请输入邮件中的 12 位验证码" }]}>
                  <Input size="large" autoComplete="one-time-code" autoCapitalize="none" maxLength={12} />
                </Form.Item>
                <Button type="link" onClick={() => go(mode)}>重新获取验证码</Button>
              </>
            )}
            {mode === "register" && step === 2 && (
              <>
                <Form.Item name="displayName" label="显示名称" rules={[required("请输入显示名称"), { whitespace: true, message: "请输入显示名称" }]}>
                  <Input maxLength={32} size="large" autoComplete="nickname" />
                </Form.Item>
                <Form.Item name="accepted" valuePropName="checked" rules={[{ validator: (_: unknown, value: boolean) => value ? Promise.resolve() : Promise.reject(new Error("请同意服务条款与隐私声明")) }]}>
                  <Checkbox>我同意<a href={options.terms} target="_blank" rel="noreferrer">服务条款</a>与<a href={options.privacy} target="_blank" rel="noreferrer">隐私声明</a></Checkbox>
                </Form.Item>
              </>
            )}
            {error && <Alert type="error" showIcon message={error} role="alert" />}
            <Button block type="primary" size="large" htmlType="submit" loading={busy}>
              {mode === "login" ? "登录" : step === 0 ? "发送验证码" : step === 1 ? "验证邮箱" : mode === "register" ? "创建账号" : "重置密码"}
            </Button>
          </Form>
        )}
        <nav className="auth-nav" aria-label="账号入口">
          {mode === "login" ? (
            <>
              {options.google && <Button block size="large" icon={<GoogleOutlined />} href="/api/platform/auth/google" disabled={busy}>使用 Google 登录</Button>}
              <Button type="link" disabled={busy} onClick={() => { setAccountLogin(!accountLogin); setError(""); form.resetFields(["email"]); }}>{accountLogin ? "使用邮箱登录" : "使用账号登录"}</Button>
            </>
          ) : step !== 3 && <Button type="link" disabled={busy} onClick={() => go("login")}>返回登录</Button>}
        </nav>
      </section>
      <footer className="auth-footer">
        {(options.terms || options.privacy) && (
          <nav className="auth-policy" aria-label="站点政策">
            {options.terms && <a href={options.terms} target="_blank" rel="noreferrer">服务条款</a>}
            {options.privacy && <a href={options.privacy} target="_blank" rel="noreferrer">隐私声明</a>}
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
