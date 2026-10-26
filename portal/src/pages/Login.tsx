import { useState } from "react";
import { Alert, Button, Card, Form, Input, Typography } from "antd";
import { api, type Me } from "../api";

export default function Login({ onLogin }: { onLogin: (user: Me) => void }) {
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit({ username, password }: { username: string; password: string }) {
    setError("");
    setSubmitting(true);
    try {
      onLogin(await api.login(username, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="center">
      <Card style={{ width: "100%", maxWidth: 380 }} styles={{ body: { padding: 32 } }}>
        <Typography.Title level={3} style={{ textAlign: "center", marginTop: 0, marginBottom: 24 }}>
          Vibebooth
        </Typography.Title>
        <Form layout="vertical" requiredMark={false} onFinish={submit}>
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: "请输入用户名" }]}>
            <Input size="large" autoComplete="username" autoCapitalize="none" />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: "请输入密码" }]}>
            <Input.Password size="large" autoComplete="current-password" />
          </Form.Item>
          {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
          <Button type="primary" htmlType="submit" size="large" block loading={submitting}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
