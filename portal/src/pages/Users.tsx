import { useEffect, useState } from "react";
import { Alert, Button, Card, Checkbox, Col, Divider, Flex, Form, Input, List, Row, Space, Tag, Typography } from "antd";
import { api, isAdmin, type MenuGrant, type User, type UserMenus } from "../api";

// 用户页：给使用者开账号、重置密码、停用账号，并按人勾选能看到哪些应用的哪些菜单。
// 宽屏上左边是用户列表、右边是选中用户的详情；窄屏上详情排在列表下面。
export default function Users({ me }: { me: User }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<number | null>(null);

  function load() {
    api
      .users()
      .then(setUsers)
      .catch((err) => setError(err.message));
  }
  useEffect(load, []);

  const current = users?.find((u) => u.id === selected);

  return (
    <Flex vertical gap={16}>
      <CreateUser
        onCreated={(u) => {
          load();
          setSelected(u.id);
        }}
      />
      <Row gutter={[16, 16]} align="top">
        <Col xs={24} lg={9}>
          <Card title="用户" styles={{ body: { padding: "4px 0" } }}>
            {error && <Alert type="error" message={error} showIcon style={{ margin: 16 }} />}
            <List
              loading={users === null && !error}
              dataSource={users ?? []}
              renderItem={(u) => (
                <List.Item
                  onClick={() => setSelected(u.id === selected ? null : u.id)}
                  style={{
                    cursor: "pointer",
                    paddingInline: 20,
                    background: u.id === selected ? "var(--bg)" : undefined,
                  }}
                >
                  <Flex vertical gap={2}>
                    <Space size={8} wrap>
                      <Typography.Text strong style={{ color: u.id === selected ? "var(--accent)" : undefined }}>
                        {u.displayName}
                      </Typography.Text>
                      {isAdmin(u) && <Tag color="blue">管理员</Tag>}
                      {u.disabled && <Tag color="error">已停用</Tag>}
                    </Space>
                    <Typography.Text type="secondary">{u.username}</Typography.Text>
                  </Flex>
                </List.Item>
              )}
            />
          </Card>
        </Col>
        <Col xs={24} lg={15}>
          {current ? (
            <UserDetail key={current.id} user={current} isMe={current.id === me.id} onSaved={load} />
          ) : (
            <Card>
              <Typography.Text type="secondary">选择一个用户，查看和修改这个用户的账号与菜单权限。</Typography.Text>
            </Card>
          )}
        </Col>
      </Row>
    </Flex>
  );
}

type CreateForm = { username: string; displayName?: string; password: string; admin: boolean };

function CreateUser({ onCreated }: { onCreated: (u: User) => void }) {
  const [form] = Form.useForm<CreateForm>();
  const [error, setError] = useState("");

  async function submit(values: CreateForm) {
    setError("");
    try {
      const u = await api.createUser({ ...values, displayName: values.displayName ?? "" });
      form.resetFields();
      onCreated(u);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    }
  }

  return (
    <Card title="新建用户">
      <Form form={form} layout="vertical" requiredMark={false} initialValues={{ admin: false }} onFinish={submit}>
        <Row gutter={16}>
          <Col xs={24} md={8}>
            <Form.Item label="用户名（登录用）" name="username" rules={[{ required: true, message: "请输入用户名" }]}>
              <Input autoCapitalize="none" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item label="显示名称" name="displayName">
              <Input placeholder="不填则同用户名" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item label="初始密码（至少 8 位）" name="password" rules={[{ required: true, message: "请输入初始密码" }]}>
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="admin" valuePropName="checked">
          <Checkbox>管理员（拥有全部菜单，能管理应用和用户）</Checkbox>
        </Form.Item>
        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
        <Button type="primary" htmlType="submit">
          创建
        </Button>
      </Form>
    </Card>
  );
}

function UserDetail({ user, isMe, onSaved }: { user: User; isMe: boolean; onSaved: () => void }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [admin, setAdmin] = useState(isAdmin(user));
  const [disabled, setDisabled] = useState(user.disabled);
  const [password, setPassword] = useState("");
  const [menus, setMenus] = useState<UserMenus | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function loadMenus() {
    api
      .userMenus(user.id)
      .then(setMenus)
      .catch((err) => setMessage({ ok: false, text: err.message }));
  }
  useEffect(loadMenus, [user.id]);

  async function act(action: () => Promise<void>, success: string) {
    setMessage(null);
    try {
      await action();
      setMessage({ ok: true, text: success });
      onSaved();
      loadMenus();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "操作失败" });
    }
  }

  function save() {
    act(() => api.updateUser(user.id, { displayName, admin, disabled }), "已保存");
  }

  function resetPassword() {
    act(() => api.setPassword(user.id, password), "密码已重置，该用户需要用新密码重新登录").then(() => setPassword(""));
  }

  // 勾选结果和默认值相同时直接恢复默认，数据库里只留和默认不同的设置。
  function toggle(module: string, menu: MenuGrant) {
    const next = !menu.allowed;
    act(() => api.setUserMenu(user.id, module, menu.id, next === menu.default ? null : next), "菜单权限已更新");
  }

  return (
    <Card title={user.displayName}>
      {message && (
        <Alert
          type={message.ok ? "success" : "error"}
          message={message.text}
          showIcon
          closable
          onClose={() => setMessage(null)}
          style={{ marginBottom: 16 }}
        />
      )}

      <Form layout="vertical" onFinish={save}>
        <Form.Item label="显示名称" required>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        </Form.Item>
        <Flex vertical gap={8} style={{ marginBottom: 16 }}>
          <Checkbox checked={admin} onChange={(e) => setAdmin(e.target.checked)} disabled={isMe}>
            管理员
          </Checkbox>
          <Checkbox checked={disabled} onChange={(e) => setDisabled(e.target.checked)} disabled={isMe}>
            停用（不能登录，已登录的设备立即退出）
          </Checkbox>
          {isMe && <Typography.Text type="secondary">不能取消自己的管理员，也不能停用自己。</Typography.Text>}
        </Flex>
        <Button type="primary" htmlType="submit">
          保存
        </Button>
      </Form>

      <Divider />

      <Form layout="vertical" onFinish={resetPassword}>
        <Form.Item label="重置密码" style={{ marginBottom: 0 }}>
          <Space.Compact style={{ width: "100%" }}>
            <Input.Password
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="新密码，至少 8 位"
              autoComplete="new-password"
              required
            />
            <Button htmlType="submit">重置密码</Button>
          </Space.Compact>
        </Form.Item>
      </Form>

      <Divider />

      <Typography.Title level={5} style={{ marginTop: 0 }}>
        菜单权限
      </Typography.Title>
      {menus?.admin && <Typography.Text type="secondary">管理员拥有全部菜单。</Typography.Text>}
      {menus && menus.modules.length === 0 && <Typography.Text type="secondary">还没有安装任何应用。</Typography.Text>}
      <Flex vertical gap={16} style={{ marginTop: 8 }}>
        {menus?.modules.map((m) => (
          <div key={m.id}>
            <Typography.Text strong>{m.name}</Typography.Text>
            <Flex vertical gap={6} style={{ marginTop: 6 }}>
              {m.menus.map((menu) => (
                <Space key={menu.id} size={12} wrap>
                  <Checkbox checked={menu.allowed} disabled={menus.admin} onChange={() => toggle(m.id, menu)}>
                    {menu.name}
                  </Checkbox>
                  {!menus.admin &&
                    (menu.override === null ? (
                      <Tag>默认</Tag>
                    ) : (
                      <Button
                        type="link"
                        size="small"
                        style={{ padding: 0 }}
                        onClick={() => act(() => api.setUserMenu(user.id, m.id, menu.id, null), "已恢复默认")}
                      >
                        恢复默认（{menu.default ? "有" : "无"}）
                      </Button>
                    ))}
                </Space>
              ))}
            </Flex>
          </div>
        ))}
      </Flex>
    </Card>
  );
}
