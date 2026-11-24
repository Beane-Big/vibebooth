import { useEffect, useState, type ReactNode } from "react";
import {
  Alert,
  App as AntApp,
  Avatar,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  Empty,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { AppstoreOutlined, HomeOutlined, PlusOutlined, SearchOutlined } from "@ant-design/icons";
import { api, isAdmin, userDisplayName, type AppGrant, type Contact, type Grant, type Me, type Member, type Person, type User, type UserInput, type UserMenus } from "../api";
import ListDetail from "../components/ListDetail";
import MyPassword from "../components/MyPassword";
import MyPhoto from "../components/MyPhoto";
import PersonAvatar from "../components/PersonAvatar";
import SwitchRow from "../components/SwitchRow";
import { confirmRules, passwordRules } from "../password";

// 一项授权是整个应用、功能权限还是菜单，三者分开存。
type GrantKind = "app" | "perm" | "menu";

// 应用超过这个数时，权限页签上出现搜索和“只看已开通”。
const MANY_APPS = 6;

// 账号和人员一一对应：管理员看到的就是账号列表，每个账号都是一个人。管理员自己的资料通过“我”入口，
// 非管理员看的联系人列表在 Contacts.tsx 里。
export default function Users({ me, onMeChanged }: { me: Me; onMeChanged: () => void }) {
  return <AdminUsers me={me} onMeChanged={onMeChanged} />;
}

// SearchBox 是成员列表顶部的搜索框。
function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div style={{ padding: "0 16px 8px" }}>
      <Input allowClear prefix={<SearchOutlined />} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// MemberDetail 是联系人详情：显示名称按 备注 > 姓名 > 账号，姓名和账号只读，备注只有自己能改。
export function MemberDetail({ contact, onSaved, onRemove }: {
  contact: Contact; onSaved: () => void; onRemove: () => void;
}) {
  const { message } = AntApp.useApp();
  const [remark, setRemark] = useState(contact.remark);
  const display = contact.remark.trim() || contact.name.trim() || contact.username;

  async function save() {
    try {
      await api.setContactRemark(contact.id, remark);
      message.success(remark.trim() ? "备注已保存" : "备注已删除");
      onSaved();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "保存失败");
    }
  }

  return (
    <Card>
      <Flex gap={16} align="center">
        <PersonAvatar person={contact} size={56} />
        <Flex vertical gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Flex gap={8} align="center" wrap="wrap">
            <Typography.Title level={4} style={{ margin: 0 }}>
              {display}
            </Typography.Title>
            {contact.status === "accepted" ? <Tag color="green">互为好友</Tag> : <Tag color="orange">待对方确认</Tag>}
          </Flex>
          <Typography.Text type="secondary">{contact.username}</Typography.Text>
        </Flex>
      </Flex>
      <Row gutter={16} style={{ marginTop: 24 }}>
        <Col xs={24} md={12}>
          <Form layout="vertical">
            <Form.Item label="姓名">
              <Input value={contact.name || "—"} disabled />
            </Form.Item>
            <Form.Item label="账号">
              <Input value={contact.username} disabled />
            </Form.Item>
          </Form>
        </Col>
        <Col xs={24} md={12}>
          <Form layout="vertical" requiredMark={false} onFinish={save}>
            <Form.Item label="备注">
              <Space.Compact style={{ width: "100%" }}>
                <Input value={remark} maxLength={200} onChange={(e) => setRemark(e.target.value)} />
                <Button type="primary" htmlType="submit" disabled={remark.trim() === contact.remark}>
                  保存
                </Button>
              </Space.Compact>
            </Form.Item>
          </Form>
        </Col>
      </Row>
      <Popconfirm title="移除这个联系人？" onConfirm={onRemove} okText="移除" cancelText="取消">
        <Button danger>移除联系人</Button>
      </Popconfirm>
    </Card>
  );
}

// SelfDetail 将本人的姓名、头像和密码统一放在账号页签中。
export function SelfDetail({ member, onSaved }: { member: Member; onSaved: () => void }) {
  const { message } = AntApp.useApp();
  const [tab, setTab] = useState("account");
  const [name, setName] = useState(member.name);
  const [photoOpen, setPhotoOpen] = useState(false);

  async function saveName() {
    try {
      await api.setMyName(name);
      message.success("姓名已保存");
      onSaved();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "保存失败");
    }
  }

  return (
    <>
      <DetailCard
        avatar={<PersonAvatar person={member} size={56} />}
        title={member.name}
        subtitle="这是你自己"
        tab={tab}
        onTab={setTab}
        items={[
          {
            key: "account",
            label: "账号",
            children: (
              <>
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form layout="vertical" requiredMark={false} onFinish={saveName}>
                    <Form.Item label="姓名">
                      <Space.Compact style={{ width: "100%" }}>
                        <Input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} />
                        <Button type="primary" htmlType="submit" disabled={!name.trim() || name.trim() === member.name}>
                          保存
                        </Button>
                      </Space.Compact>
                    </Form.Item>
                  </Form>
                </Col>
                <Col xs={24} md={12}>
                  <Form layout="vertical">
                    <Form.Item label="头像">
                      <Flex gap={12} align="center">
                        <PersonAvatar person={member} size={32} />
                        <Button onClick={() => setPhotoOpen(true)}>更换头像</Button>
                      </Flex>
                    </Form.Item>
                  </Form>
                </Col>
              </Row>
              <div className="section"><MyPassword /></div>
              </>
            ),
          },
        ]}
      />
      <Modal title="更换头像" open={photoOpen} footer={null} onCancel={() => setPhotoOpen(false)} width={360}>
        <MyPhoto name={member.name} photo={member.photo} onChange={onSaved} />
      </Modal>
    </>
  );
}

// AdminUsers 是管理员看到的账号管理：左边是所有账号（每个账号都是一个人），右边是选中账号的账号设置和权限。
// 账号和人员一一对应，所以这里不再有“人员”和“账号”两套东西，也没有关联操作；管理员自己的资料通过“我”入口。
function AdminUsers({ me, onMeChanged }: { me: Me; onMeChanged: () => void }) {
  const [persons, setPersons] = useState<Person[] | null>(null);
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<number | "self" | null>(null);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);

  function load() {
    Promise.all([api.persons(), api.users()])
      .then(([p, u]) => {
        setPersons(p);
        setUsers(u);
      })
      .catch((err) => setError(err.message));
  }
  useEffect(load, []);

  function refresh() {
    load();
    onMeChanged();
  }

  const personOf = (user: User) => persons?.find((p) => p.id === user.personId);
  const q = query.trim().toLowerCase();
  const match = (...texts: string[]) => !q || texts.some((t) => t.toLowerCase().includes(q));
  const shown = (users ?? []).filter((u) => u.id !== me.id && match(userDisplayName(u), u.username, personOf(u)?.note ?? ""));
  const currentUser = selected === "self" ? me : users?.find((u) => u.id === selected);

  const list = (
    <Card
      title="联系人"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
          添加账号
        </Button>
      }
      styles={{ body: { padding: "0 0 8px" } }}
    >
      <SearchBox value={query} onChange={setQuery} placeholder="搜索姓名、账号或备注" />
      {error && <Alert type="error" message={error} showIcon style={{ margin: "0 16px 8px" }} />}
      <MemberRow
        avatar={<PersonAvatar person={{ name: userDisplayName(me), photo: me.photo }} />}
        title={userDisplayName(me)}
        subtitle="我的账号"
        tags={<Tag color="blue">我</Tag>}
        active={selected === "self"}
        onClick={() => setSelected("self")}
      />
      {users && shown.length === 0 && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={q ? "没有找到" : "还没有账号，点“添加账号”开始。"} />
      )}
      {shown.map((u) => {
        const person = personOf(u);
        return (
          <MemberRow
            key={u.id}
            avatar={<PersonAvatar person={person ?? { name: userDisplayName(u), photo: "" }} />}
            title={userDisplayName(u)}
            subtitle={userDisplayName(u) === u.username ? undefined : u.username}
            tags={accountTags([u])}
            active={selected === u.id}
            onClick={() => setSelected(u.id)}
          />
        );
      })}
    </Card>
  );

  const detail =
    selected === "self" ? (
      <SelfDetail key="self" member={{ id: me.id, name: userDisplayName(me), photo: me.photo, remark: "", self: true }} onSaved={refresh} />
    ) : currentUser && persons ? (
      <AccountDetail key={currentUser.id} user={currentUser} person={personOf(currentUser)} me={me} onSaved={refresh} />
    ) : (
      <Card>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择账号" />
      </Card>
    );

  return (
    <>
      <ListDetail list={list} detail={detail} selected={selected !== null} onBack={() => setSelected(null)} />
      <Modal title="添加账号" open={adding} footer={null} onCancel={() => setAdding(false)} destroyOnHidden>
        <AccountForm
          onSubmit={async (input) => {
            const u = await api.createUser(input);
            setAdding(false);
            load();
            setSelected(u.id);
          }}
        />
      </Modal>
    </>
  );
}

// accountTags 是列表里的小标记：有管理员账号、有停用的账号。
function accountTags(accounts: User[]) {
  return (
    <>
      {accounts.some(isAdmin) && <Tag color="blue">管理员</Tag>}
      {accounts.some((u) => u.disabled) && <Tag color="error">已停用</Tag>}
    </>
  );
}

export function MemberRow({
  avatar,
  title,
  subtitle,
  tags,
  active,
  onClick,
}: {
  avatar: ReactNode;
  title: string;
  subtitle?: string;
  tags?: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <div className={`member-row${active ? " active" : ""}`} onClick={onClick} role="button" tabIndex={0}>
      {avatar}
      <Flex vertical gap={2} style={{ minWidth: 0, flex: 1 }}>
        <Flex gap={6} align="center" wrap>
          <Typography.Text strong style={{ color: active ? "var(--accent)" : undefined }}>
            {title}
          </Typography.Text>
          {tags}
        </Flex>
        {subtitle && (
          <Typography.Text type="secondary" ellipsis>
            {subtitle}
          </Typography.Text>
        )}
      </Flex>
    </div>
  );
}




// DetailCard 是右边的详情：头部是头像和名字，下面是页签。
function DetailCard({
  avatar,
  title,
  subtitle,
  extra,
  tab,
  onTab,
  items,
}: {
  avatar: ReactNode;
  title: string;
  subtitle: ReactNode;
  extra?: ReactNode;
  tab: string;
  onTab: (key: string) => void;
  items: { key: string; label: string; children: ReactNode }[];
}) {
  return (
    <Card>
      <Flex gap={16} align="center">
        {avatar}
        <Flex vertical gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          <Typography.Text type="secondary">{subtitle}</Typography.Text>
        </Flex>
        {extra}
      </Flex>
      <Tabs activeKey={tab} onChange={onTab} items={items} style={{ marginTop: 8 }} />
    </Card>
  );
}

// AccountDetail 只展示账号管理和权限；姓名、账号及头像不能由管理员代改。
function AccountDetail({ user, person, me, onSaved }: { user: User; person: Person | undefined; me: Me; onSaved: () => void }) {
  const [tab, setTab] = useState("account");
  const name = userDisplayName(user);
  return (
    <DetailCard
      avatar={<PersonAvatar person={person ?? { name, photo: "" }} />}
      title={name}
      subtitle={
        <Space size={6} wrap>
          {person?.note && <span>{person.note}</span>}
          {name !== user.username && <span>{user.username}</span>}
          {accountTags([user])}
        </Space>
      }
      tab={tab}
      onTab={setTab}
      items={[
        {
          key: "account",
          label: "账号",
          children: <AccountSettings user={user} person={person} me={me} onSaved={onSaved} />,
        },
        { key: "perms", label: "权限", children: <AppPermissions user={user} /> },
      ]}
    />
  );
}

type CreateForm = { username: string; displayName: string; password: string; confirm: string; admin: boolean };

// AccountForm 新建账号：账号和人员一一对应，新建账号会自动创建对应的人员（姓名用显示名称，没有就用账号）。
function AccountForm({ onSubmit }: { onSubmit: (input: UserInput) => Promise<void> }) {
  const [form] = Form.useForm<CreateForm>();
  const [error, setError] = useState("");

  async function submit(values: CreateForm) {
    setError("");
    const { confirm: _, ...input } = values;
    try {
      await onSubmit({ ...input, displayName: values.displayName.trim() });
      form.resetFields();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    }
  }

  return (
    <Form form={form} layout="vertical" requiredMark={false} initialValues={{ admin: false }} onFinish={submit}>
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item label="用户名（登录用）" name="username" rules={[{ required: true, message: "请输入用户名" }]}>
            <Input autoCapitalize="none" />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item label="姓名（可选，不填用账号）" name="displayName">
            <Input maxLength={30} />
          </Form.Item>
        </Col>
      </Row>
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item label="初始密码（至少 8 位）" name="password" rules={passwordRules}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item label="确认密码" name="confirm" dependencies={["password"]} rules={confirmRules}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Col>
      </Row>
      <Form.Item name="admin" valuePropName="checked">
        <Checkbox>管理员（拥有全部权限，能管理应用和用户）</Checkbox>
      </Form.Item>
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
      <Button type="primary" htmlType="submit">
        添加
      </Button>
    </Form>
  );
}

// AccountSettings 管理账号状态、备注与密码，身份资料只读。
function AccountSettings({ user, person, me, onSaved }: { user: User; person: Person | undefined; me: Me; onSaved: () => void }) {
  const { message } = AntApp.useApp();
  const isMe = user.id === me.id;
  const [admin, setAdmin] = useState(isAdmin(user));
  const [disabled, setDisabled] = useState(user.disabled);
  const [note, setNote] = useState(person?.note ?? "");
  const [passwordForm] = Form.useForm<{ password: string; confirm: string; adminPassword: string }>();

  async function act(action: () => Promise<void>, success: string) {
    try {
      await action();
      message.success(success);
      onSaved();
      return true;
    } catch (err) {
      message.error(err instanceof Error ? err.message : "操作失败");
      return false;
    }
  }

  // 拨动开关立即保存；失败时开关退回原样。
  async function toggle(next: { admin: boolean; disabled: boolean }, success: string) {
    const prev = { admin, disabled };
    setAdmin(next.admin);
    setDisabled(next.disabled);
    if (!(await act(() => api.updateUser(user.id, next), success))) {
      setAdmin(prev.admin);
      setDisabled(prev.disabled);
    }
  }

  return (
    <Flex vertical gap={0}>
      <Form layout="vertical" requiredMark={false}>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item label="用户名">
              <Input value={user.username} disabled />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item label="姓名">
              <Input value={userDisplayName(user)} disabled />
            </Form.Item>
          </Col>
        </Row>
      </Form>
      <Form layout="vertical" onFinish={() => act(() => api.setUserRemark(user.id, note), "备注已保存")}>
        <Form.Item label="备注">
          <Space.Compact block>
            <Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
            <Button type="primary" htmlType="submit" disabled={note.trim() === (person?.note ?? "")}>保存</Button>
          </Space.Compact>
        </Form.Item>
      </Form>
      <Flex vertical gap={10}>
        <SwitchRow
          title="管理员"
          description="拥有全部权限，能管理应用和用户"
          checked={admin}
          disabled={isMe}
          onChange={(v) => toggle({ admin: v, disabled }, v ? "已设为管理员" : "已取消管理员")}
        />
        <SwitchRow
          title="停用"
          description="不能登录，已登录的设备立即退出"
          checked={disabled}
          disabled={isMe}
          onChange={(v) => toggle({ admin, disabled: v }, v ? "账号已停用" : "账号已启用")}
        />
        {isMe && <Typography.Text type="secondary">不能取消自己的管理员，也不能停用自己。</Typography.Text>}
      </Flex>

      <div className="section">
        <Typography.Text strong>重置密码</Typography.Text>
        <Form
          form={passwordForm}
          layout="vertical"
          requiredMark={false}
          onFinish={({ password, adminPassword }) =>
            act(() => api.setPassword(user.id, password, adminPassword), "密码已重置，他需要用新密码重新登录").then(
              (ok) => ok && passwordForm.resetFields(),
            )
          }
          style={{ marginTop: 8 }}
        >
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="password" rules={passwordRules}>
                <Input.Password placeholder="新密码，至少 8 位" autoComplete="new-password" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="confirm" dependencies={["password"]} rules={confirmRules}>
                <Input.Password placeholder="再输入一次" autoComplete="new-password" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="adminPassword" rules={[{ required: true, message: "请输入你自己的密码" }]}>
                <Input.Password placeholder={`你的密码（${me.username}）`} autoComplete="current-password" />
              </Form.Item>
            </Col>
          </Row>
          <Button htmlType="submit">重置密码</Button>
        </Form>
      </div>
    </Flex>
  );
}

// AppPermissions 是一个账号的权限：每个应用一张可折叠的卡片，标题行的开关决定能不能用整个应用，
// 展开后是功能权限和页面。平台排在第一张。应用多时可以搜索、只看已开通的。
function AppPermissions({ user }: { user: User }) {
  const { message } = AntApp.useApp();
  const [data, setData] = useState<UserMenus | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [onlyOn, setOnlyOn] = useState(false);

  function load() {
    api
      .userMenus(user.id)
      .then(setData)
      .catch((err) => setError(err.message));
  }
  useEffect(load, [user.id]);

  // 结果和默认值相同时直接恢复默认，数据库里只留和默认不同的设置。allowed 为 null 表示恢复默认。
  async function set(kind: GrantKind, module: string, id: string, allowed: boolean | null) {
    try {
      if (kind === "app") await api.setUserApp(user.id, module, allowed);
      else if (kind === "perm") await api.setUserPerm(user.id, module, id, allowed);
      else await api.setUserMenu(user.id, module, id, allowed);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "操作失败");
    }
  }
  const toggle = (kind: GrantKind, module: string, g: Grant) =>
    set(kind, module, g.id, !g.allowed === g.default ? null : !g.allowed);

  if (error) return <Alert type="error" message={error} showIcon />;
  if (!data) return <Card loading bordered={false} />;

  const admin = data.admin;
  const q = query.trim().toLowerCase();
  const shown = data.modules.filter((m) => (!onlyOn || m.access.allowed) && (!q || m.name.toLowerCase().includes(q)));
  // 单独设置过的显示“恢复默认”，管理员的权限不能改。
  const reset = (kind: GrantKind, module: string, g: Grant) =>
    (!admin || g.optIn) &&
    g.override !== null && (
      <Button type="link" size="small" onClick={() => set(kind, module, g.id, null)}>
        恢复默认
      </Button>
    );
  const rows = (kind: GrantKind, m: AppGrant, list: Grant[]) =>
    list.map((g) => (
      <SwitchRow
        key={`${kind}:${g.id}`}
        title={g.name}
        description={g.description}
        checked={g.allowed}
        disabled={(admin && !g.optIn) || !m.access.allowed}
        onChange={() => toggle(kind, m.id, g)}
        extra={reset(kind, m.id, g)}
      />
    ));

  return (
    <Flex vertical gap={12}>
      <Typography.Text type="secondary">
        {admin
          ? "管理员自动拥有常规权限，需要手动开通的功能可单独设置。"
          : "关掉一个应用，它就对这个账号隐藏，改网址也打不开。关掉“平台”后，他打不开门户，只能直接打开自己能用的应用。"}
      </Typography.Text>
      {data.modules.length > MANY_APPS && (
        <Flex gap={8} wrap>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索应用"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1, minWidth: 180 }}
          />
          <Segmented
            value={onlyOn ? "on" : "all"}
            onChange={(v) => setOnlyOn(v === "on")}
            options={[
              { value: "all", label: "全部" },
              { value: "on", label: "已开通" },
            ]}
          />
        </Flex>
      )}
      <Collapse
        className="app-grants"
        bordered={false}
        expandIconPosition="end"
        items={shown.map((m) => {
          const items = [...m.perms, ...m.menus];
          const on = items.filter((g) => g.allowed).length;
          return {
            key: m.id,
            label: (
              <Flex gap={12} align="center">
                {m.icon ? (
                  <img src={m.icon} alt="" className="app-grant-icon" />
                ) : (
                  <Avatar
                    shape="square"
                    size={32}
                    icon={m.id === "platform" ? <HomeOutlined /> : <AppstoreOutlined />}
                    className="app-grant-icon"
                    style={m.id === "platform" ? { background: "var(--accent)" } : undefined}
                  />
                )}
                <Flex vertical style={{ minWidth: 0 }}>
                  <Typography.Text strong>{m.name}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {!m.access.allowed ? "未开通" : items.length > 0 ? `已开通 · ${on}/${items.length} 项权限` : "已开通"}
                  </Typography.Text>
                </Flex>
              </Flex>
            ),
            extra: (
              <Space size={4} onClick={(e) => e.stopPropagation()}>
                {reset("app", m.id, m.access)}
                <Switch checked={m.access.allowed} disabled={admin} onChange={() => toggle("app", m.id, m.access)} />
              </Space>
            ),
            children:
              items.length === 0 ? (
                <Typography.Text type="secondary">这个应用没有可单独设置的权限，开通后就能使用全部功能。</Typography.Text>
              ) : (
                <Flex vertical>
                  {!m.access.allowed && (
                    <Typography.Text type="secondary" style={{ marginBottom: 8 }}>
                      应用未开通，下面的设置在开通后才生效。
                    </Typography.Text>
                  )}
                  {m.perms.length > 0 && m.menus.length > 0 && <Typography.Text type="secondary" className="grant-group">功能</Typography.Text>}
                  {rows("perm", m, m.perms)}
                  {m.perms.length > 0 && m.menus.length > 0 && <Typography.Text type="secondary" className="grant-group">页面</Typography.Text>}
                  {rows("menu", m, m.menus)}
                </Flex>
              ),
          };
        })}
      />
      {shown.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有找到应用" />}
    </Flex>
  );
}
