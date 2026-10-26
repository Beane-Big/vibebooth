import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Avatar,
  Button,
  Card,
  Checkbox,
  Col,
  Divider,
  Flex,
  Form,
  Input,
  List,
  Popconfirm,
  Row,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import { api, isAdmin, type Grant, type Person, type PersonInput, type User, type UserMenus } from "../api";
import { resizePhoto } from "../photo";

// 选中的是一个人员，还是一个账号。
type Selection = { kind: "person"; id: number } | { kind: "user"; id: number };

// 账号详情里的一项授权是功能权限还是菜单，两者分开存。
type GrantKind = "perm" | "menu";

// 用户应用：维护人员（家庭成员等），给人员开通账号或关联已有账号，并管理每个账号的密码、停用和权限。
// 一个账号最多属于一个人员，一个人员可以有多个账号。宽屏上左边是列表、右边是选中项的详情；窄屏上详情排在列表下面。
export default function Users({ me }: { me: User }) {
  const [persons, setPersons] = useState<Person[] | null>(null);
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Selection | null>(null);

  function load() {
    Promise.all([api.persons(), api.users()])
      .then(([p, u]) => {
        setPersons(p);
        setUsers(u);
      })
      .catch((err) => setError(err.message));
  }
  useEffect(load, []);

  const isSelected = (s: Selection) => selected?.kind === s.kind && selected.id === s.id;
  const toggle = (s: Selection) => setSelected(isSelected(s) ? null : s);
  const accountsOf = (personId: number) => users?.filter((u) => u.personId === personId) ?? [];
  const unlinked = users?.filter((u) => u.personId === null) ?? [];
  const currentPerson = selected?.kind === "person" ? persons?.find((p) => p.id === selected.id) : undefined;
  const currentUser = selected?.kind === "user" ? users?.find((u) => u.id === selected.id) : undefined;
  const itemStyle = (s: Selection) => ({
    cursor: "pointer",
    paddingInline: 20,
    background: isSelected(s) ? "var(--bg)" : undefined,
  });
  const nameColor = (s: Selection) => (isSelected(s) ? "var(--accent)" : undefined);

  return (
    <Flex vertical gap={16}>
      <Card title="添加人员">
        <PersonForm
          submitText="添加"
          onSubmit={async (input) => {
            const p = await api.createPerson(input);
            load();
            setSelected({ kind: "person", id: p.id });
          }}
        />
      </Card>
      <Row gutter={[16, 16]} align="top">
        <Col xs={24} lg={9}>
          <Flex vertical gap={16}>
            <Card title="人员" styles={{ body: { padding: "4px 0" } }}>
              {error && <Alert type="error" message={error} showIcon style={{ margin: 16 }} />}
              <List
                loading={persons === null && !error}
                locale={{ emptyText: "还没有人员，先在上面添加。" }}
                dataSource={persons ?? []}
                renderItem={(p) => {
                  const s: Selection = { kind: "person", id: p.id };
                  const count = accountsOf(p.id).length;
                  return (
                    <List.Item onClick={() => toggle(s)} style={itemStyle(s)}>
                      <Space size={12}>
                        <PersonAvatar person={p} />
                        <Flex vertical gap={2}>
                          <Typography.Text strong style={{ color: nameColor(s) }}>
                            {p.name}
                          </Typography.Text>
                          <Typography.Text type="secondary">{count > 0 ? `${count} 个账号` : "没有账号"}</Typography.Text>
                        </Flex>
                      </Space>
                    </List.Item>
                  );
                }}
              />
            </Card>
            {unlinked.length > 0 && (
              <Card title="未关联人员的账号" styles={{ body: { padding: "4px 0" } }}>
                <List
                  dataSource={unlinked}
                  renderItem={(u) => {
                    const s: Selection = { kind: "user", id: u.id };
                    return (
                      <List.Item onClick={() => toggle(s)} style={itemStyle(s)}>
                        <AccountText user={u} color={nameColor(s)} />
                      </List.Item>
                    );
                  }}
                />
              </Card>
            )}
          </Flex>
        </Col>
        <Col xs={24} lg={15}>
          {currentPerson ? (
            <PersonDetail
              key={currentPerson.id}
              person={currentPerson}
              accounts={accountsOf(currentPerson.id)}
              unlinked={unlinked}
              onSelectUser={(id) => setSelected({ kind: "user", id })}
              onSaved={load}
              onDeleted={() => {
                setSelected(null);
                load();
              }}
            />
          ) : currentUser && persons ? (
            <UserDetail
              key={currentUser.id}
              user={currentUser}
              persons={persons}
              isMe={currentUser.id === me.id}
              onBack={currentUser.personId !== null ? () => setSelected({ kind: "person", id: currentUser.personId! }) : undefined}
              onSaved={load}
            />
          ) : (
            <Card>
              <Typography.Text type="secondary">选择一个人员，查看和修改他的信息与账号；选择一个账号，修改密码和菜单权限。</Typography.Text>
            </Card>
          )}
        </Col>
      </Row>
    </Flex>
  );
}

function PersonAvatar({ person, size = 40 }: { person: Pick<Person, "name" | "photo">; size?: number }) {
  return person.photo ? (
    <Avatar size={size} src={person.photo} />
  ) : (
    <Avatar size={size} style={{ backgroundColor: "var(--accent)", flex: "none" }}>
      {person.name.slice(0, 1) || "?"}
    </Avatar>
  );
}

// AccountText 是列表里的一个账号：显示名称、管理员和停用标记，下面是用户名。
function AccountText({ user, color }: { user: User; color?: string }) {
  return (
    <Flex vertical gap={2}>
      <Space size={8} wrap>
        <Typography.Text strong style={{ color }}>
          {user.displayName}
        </Typography.Text>
        {isAdmin(user) && <Tag color="blue">管理员</Tag>}
        {user.disabled && <Tag color="error">已停用</Tag>}
      </Space>
      <Typography.Text type="secondary">{user.username}</Typography.Text>
    </Flex>
  );
}

// PersonForm 填写人员的姓名、备注和照片；点头像选择照片，会自动裁成正方形。新增和修改共用。
function PersonForm({
  initial = { name: "", note: "", photo: "" },
  submitText,
  onSubmit,
}: {
  initial?: PersonInput;
  submitText: string;
  onSubmit: (input: PersonInput) => Promise<void>;
}) {
  const [form] = Form.useForm<Omit<PersonInput, "photo">>();
  const name = Form.useWatch("name", form) ?? initial.name;
  const [photo, setPhoto] = useState(initial.photo);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  async function pickPhoto(file: File | undefined) {
    if (!file) return;
    try {
      setPhoto(await resizePhoto(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法读取这张图片");
    }
  }

  async function submit(values: Omit<PersonInput, "photo">) {
    setError("");
    try {
      await onSubmit({ name: values.name, note: values.note ?? "", photo });
      if (!initial.name) {
        form.resetFields();
        setPhoto("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    }
  }

  return (
    <Form form={form} layout="vertical" requiredMark={false} initialValues={initial} onFinish={submit}>
      <Flex gap={16} align="flex-start" wrap>
        <Flex vertical align="center" gap={4}>
          <Button type="text" shape="circle" style={{ width: 64, height: 64, padding: 0 }} onClick={() => fileInput.current?.click()} aria-label="选择照片">
            <PersonAvatar person={{ name, photo }} size={64} />
          </Button>
          {photo ? (
            <Button type="link" size="small" danger onClick={() => setPhoto("")}>
              去掉照片
            </Button>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              点头像选照片
            </Typography.Text>
          )}
        </Flex>
        <Row gutter={16} style={{ flex: 1, minWidth: 220 }}>
          <Col xs={24} md={10}>
            <Form.Item label="姓名" name="name" rules={[{ required: true, whitespace: true, message: "请输入姓名" }]}>
              <Input maxLength={30} />
            </Form.Item>
          </Col>
          <Col xs={24} md={14}>
            <Form.Item label="备注" name="note">
              <Input maxLength={200} placeholder="可选" />
            </Form.Item>
          </Col>
        </Row>
      </Flex>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          pickPhoto(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
      <Button type="primary" htmlType="submit">
        {submitText}
      </Button>
    </Form>
  );
}

type CreateForm = { username: string; displayName?: string; password: string; admin: boolean };

function PersonDetail({
  person,
  accounts,
  unlinked,
  onSelectUser,
  onSaved,
  onDeleted,
}: {
  person: Person;
  accounts: User[];
  unlinked: User[];
  onSelectUser: (id: number) => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [adding, setAdding] = useState<"create" | "link" | null>(null);
  const [linkId, setLinkId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [form] = Form.useForm<CreateForm>();

  async function act(action: () => Promise<unknown>, success: string) {
    setMessage(null);
    try {
      await action();
      setMessage({ ok: true, text: success });
      setAdding(null);
      onSaved();
      return true;
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "操作失败" });
      return false;
    }
  }

  async function remove() {
    try {
      await api.deletePerson(person.id);
      onDeleted();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "删除失败" });
    }
  }

  async function createAccount(values: CreateForm) {
    const ok = await act(
      () => api.createUser({ ...values, displayName: values.displayName || person.name, personId: person.id }),
      "账号已开通",
    );
    if (ok) form.resetFields();
  }

  return (
    <Card
      title={person.name}
      extra={
        <Popconfirm
          title={`删除「${person.name}」？`}
          description="其他应用里此人的数据（如分数）将不再显示；他的账号会保留，只是不再关联人员。"
          okText="删除"
          okButtonProps={{ danger: true }}
          cancelText="取消"
          onConfirm={remove}
        >
          <Button type="link" danger>
            删除人员
          </Button>
        </Popconfirm>
      }
    >
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

      <PersonForm
        initial={person}
        submitText="保存"
        onSubmit={async (input) => {
          await api.updatePerson(person.id, input);
          setMessage({ ok: true, text: "已保存" });
          onSaved();
        }}
      />

      <Divider />

      <Typography.Title level={5} style={{ marginTop: 0 }}>
        账号
      </Typography.Title>
      {accounts.length === 0 ? (
        <Typography.Text type="secondary">还没有账号，开通后他就能登录平台，其他应用也能知道登录的是他。</Typography.Text>
      ) : (
        <List
          size="small"
          dataSource={accounts}
          renderItem={(u) => (
            <List.Item
              actions={[
                <Button key="open" type="link" size="small" onClick={() => onSelectUser(u.id)}>
                  密码与权限
                </Button>,
                <Popconfirm
                  key="unlink"
                  title={`解除账号 ${u.username} 和「${person.name}」的关联？`}
                  description="账号本身不会删除。"
                  okText="解除"
                  cancelText="取消"
                  onConfirm={() => act(() => api.setUserPerson(u.id, null), "已解除关联")}
                >
                  <Button type="link" size="small" danger>
                    解除关联
                  </Button>
                </Popconfirm>,
              ]}
            >
              <AccountText user={u} />
            </List.Item>
          )}
        />
      )}
      <Space style={{ marginTop: 12 }} wrap>
        <Button onClick={() => setAdding(adding === "create" ? null : "create")}>开通账号</Button>
        <Button onClick={() => setAdding(adding === "link" ? null : "link")}>关联已有账号</Button>
      </Space>

      {adding === "create" && (
        <Form
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{ admin: false }}
          onFinish={createAccount}
          style={{ marginTop: 16 }}
        >
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item label="用户名（登录用）" name="username" rules={[{ required: true, message: "请输入用户名" }]}>
                <Input autoCapitalize="none" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label="显示名称" name="displayName">
                <Input placeholder={`不填则用“${person.name}”`} />
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
          <Space>
            <Button type="primary" htmlType="submit">
              开通
            </Button>
            <Button onClick={() => setAdding(null)}>取消</Button>
          </Space>
        </Form>
      )}

      {adding === "link" && (
        <Flex gap={8} wrap style={{ marginTop: 16 }}>
          {unlinked.length === 0 ? (
            <Typography.Text type="secondary">所有账号都已经关联了人员。</Typography.Text>
          ) : (
            <>
              <Select
                placeholder="选择账号"
                style={{ flex: 1, minWidth: 200 }}
                value={linkId}
                onChange={setLinkId}
                options={unlinked.map((u) => ({
                  value: u.id,
                  label: u.displayName === u.username ? u.username : `${u.username}（${u.displayName}）`,
                }))}
              />
              <Button
                type="primary"
                disabled={linkId === null}
                onClick={() => act(() => api.setUserPerson(linkId!, person.id), "已关联").then((ok) => ok && setLinkId(null))}
              >
                关联
              </Button>
            </>
          )}
          <Button onClick={() => setAdding(null)}>取消</Button>
        </Flex>
      )}
    </Card>
  );
}

function UserDetail({
  user,
  persons,
  isMe,
  onBack,
  onSaved,
}: {
  user: User;
  persons: Person[];
  isMe: boolean;
  onBack?: () => void;
  onSaved: () => void;
}) {
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

  // 功能权限和菜单分开存。allowed 为 null 表示恢复默认。
  const setGrant = (kind: GrantKind, module: string, id: string, allowed: boolean | null) =>
    kind === "perm" ? api.setUserPerm(user.id, module, id, allowed) : api.setUserMenu(user.id, module, id, allowed);

  // 勾选结果和默认值相同时直接恢复默认，数据库里只留和默认不同的设置。
  function toggle(kind: GrantKind, module: string, grant: Grant) {
    const next = !grant.allowed;
    act(() => setGrant(kind, module, grant.id, next === grant.default ? null : next), "权限已更新");
  }

  const renderGrant = (kind: GrantKind, module: string, grant: Grant) => (
    <Space key={`${kind}:${grant.id}`} size={12} wrap>
      <Checkbox checked={grant.allowed} disabled={menus?.admin} onChange={() => toggle(kind, module, grant)}>
        {grant.name}
      </Checkbox>
      {grant.description && <Typography.Text type="secondary">{grant.description}</Typography.Text>}
      {!menus?.admin &&
        (grant.override === null ? (
          <Tag>默认</Tag>
        ) : (
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            onClick={() => act(() => setGrant(kind, module, grant.id, null), "已恢复默认")}
          >
            恢复默认（{grant.default ? "有" : "无"}）
          </Button>
        ))}
    </Space>
  );

  return (
    <Card
      title={user.displayName}
      extra={
        onBack && (
          <Button type="link" onClick={onBack}>
            返回人员
          </Button>
        )
      }
    >
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

      <Form.Item label="所属人员" style={{ marginBottom: 0 }}>
        <Select
          value={user.personId}
          allowClear
          placeholder="不关联人员"
          onChange={(v: number | undefined) =>
            act(() => api.setUserPerson(user.id, v ?? null), v ? "已关联人员" : "已解除关联")
          }
          options={persons.map((p) => ({ value: p.id, label: p.name }))}
        />
      </Form.Item>

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
        权限
      </Typography.Title>
      <Typography.Text type="secondary">
        {menus?.admin
          ? "管理员拥有全部权限。"
          : "功能权限决定能做什么，页面决定能打开哪些页面。“用户”应用只给管理员。"}
      </Typography.Text>
      <Flex vertical gap={16} style={{ marginTop: 12 }}>
        {menus?.modules.map((m) => (
          <div key={m.id}>
            <Typography.Text strong>{m.name}</Typography.Text>
            <Flex vertical gap={6} style={{ marginTop: 6 }}>
              {m.perms.length > 0 && m.menus.length > 0 && <Typography.Text type="secondary">功能权限</Typography.Text>}
              {m.perms.map((p) => renderGrant("perm", m.id, p))}
              {m.perms.length > 0 && m.menus.length > 0 && <Typography.Text type="secondary">页面</Typography.Text>}
              {m.menus.map((menu) => renderGrant("menu", m.id, menu))}
            </Flex>
          </div>
        ))}
      </Flex>
    </Card>
  );
}
