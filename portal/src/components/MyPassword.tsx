import { useState } from "react";
import { Alert, App as AntApp, Button, Col, Form, Input, Row } from "antd";
import { api } from "../api";
import { confirmRules, passwordRules } from "../password";

type PasswordForm = { currentPassword: string; password: string; confirm: string };

// MyPassword 改自己的密码：先输入当前密码，新密码输入两次。改好后其他设备要重新登录，这台不用。“用户”应用里自己的“账号”页签用它。
export default function MyPassword() {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<PasswordForm>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit({ currentPassword, password }: PasswordForm) {
    setError("");
    setSaving(true);
    try {
      await api.setMyPassword(currentPassword, password);
      message.success("密码已修改，其他设备需要用新密码重新登录");
      form.resetFields();
    } catch (err) {
      setError(err instanceof Error ? err.message : "修改失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Form form={form} layout="vertical" requiredMark={false} onFinish={submit}>
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item label="当前密码" name="currentPassword" rules={[{ required: true, message: "请输入当前密码" }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
        </Col>
      </Row>
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item label="新密码（至少 8 位）" name="password" rules={passwordRules}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item label="确认新密码" name="confirm" dependencies={["password"]} rules={confirmRules}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Col>
      </Row>
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
      <Button type="primary" htmlType="submit" loading={saving}>
        修改密码
      </Button>
    </Form>
  );
}
