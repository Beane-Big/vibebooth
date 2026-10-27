import { useEffect, useRef, useState, type ReactNode } from "react";
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
  Grid,
  Input,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { AppstoreOutlined, ArrowLeftOutlined, HomeOutlined, PlusOutlined, SearchOutlined, UserOutlined } from "@ant-design/icons";
import { api, isAdmin, type AppGrant, type Grant, type Member, type Person, type PersonInput, type User, type UserMenus } from "../api";
import MyPhoto from "../components/MyPhoto";
import PersonAvatar from "../components/PersonAvatar";
import { resizePhoto } from "../photo";

// 选中的是一个成员，还是一个没关联成员的账号。
type Selection = { kind: "person"; id: number } | { kind: "user"; id: number };

// 一项授权是整个应用、功能权限还是菜单，三者分开存。
type GrantKind = "app" | "perm" | "menu";

// 应用超过这个数时，权限页签上出现搜索和“只看已开通”。
const MANY_APPS = 6;

// 用户应用：管理员管成员、账号和权限；有“成员”权限的普通用户只能看成员，给他们写只有自己看得到的备注。
export default function Users({ me }: { me: User }) {
  return isAdmin(me) ? <AdminUsers me={me} /> : <MemberRemarks />;
}

// ListDetail 是左边列表、右边详情的布局。窄屏上先看列表，选中后只看详情，左上角返回列表。
function ListDetail({ list, detail, selected, onBack }: { list: ReactNode; detail: ReactNode; selected: boolean; onBack: () => void }) {
  const wide = !!Grid.useBreakpoint().lg;
  if (wide) {
    return (
      <Row gutter={16} align="top">
        <Col span={8}>{list}</Col>
        <Col span={16}>{detail}</Col>
      </Row>
    );
  }
  return selected ? (
    <Flex vertical gap={12}>
      <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} style={{ alignSelf: "flex-start" }}>
        成员
      </Button>
      {detail}
    </Flex>
  ) : (
    list
  );
}

// SearchBox 是成员列表顶部的搜索框。
function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div style={{ padding: "0 16px 8px" }}>
      <Input allowClear prefix={<SearchOutlined />} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// MemberRemarks 是普通用户看到的成员列表：左边是成员和自己写的备注，右边看资料、写备注，自己的资料可以改。没有账号、权限和管理员的备注。
function MemberRemarks() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [query, setQuery] = useState("");

  function load() {
    api
      .members()
      .then(setMembers)
      .catch((err) => setError(err.message));
  }
  useEffect(load, []);

  const q = query.trim().toLowerCase();
  const shown = (members ?? []).filter((m) => !q || [m.name, m.remark].some((t) => t.toLowerCase().includes(q)));
  const current = members?.find((m) => m.id === selected);

  const list = (
    <Card title="成员" styles={{ body: { padding: "0 0 8px" } }}>
      <SearchBox value={query} onChange={setQuery} placeholder="搜索姓名或备注" />
      {error && <Alert type="error" message={error} showIcon style={{ margin: "0 16px 8px" }} />}
      {members && shown.length === 0 && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={q ? "没有找到" : "还没有成员"} />
      )}
      {shown.map((m) => (
        <MemberRow
          key={m.id}
          avatar={<PersonAvatar person={m} />}
          title={m.name}
          subtitle={m.remark || "没有备注"}
          tags={m.self && <Tag color="blue">我</Tag>}
          active={m.id === selected}
          onClick={() => setSelected(m.id)}
        />
      ))}
    </Card>
  );

  const detail = current ? (
    <MemberDetail key={current.id} member={current} onSaved={load} />
  ) : (
    <Card>
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择一个成员，查看资料或给他写备注。" />
    </Card>
  );

  return <ListDetail list={list} detail={detail} selected={!!current} onBack={() => setSelected(null)} />;
}

// MemberDetail 是普通用户看到的一个成员：别人的姓名只能看，可以写只有自己看得到的备注；
// 自己的姓名和头像可以改，改的是自己关联的成员，各个应用里都会看到。
function MemberDetail({ member, onSaved }: { member: Member; onSaved: () => void }) {
  const { message } = AntApp.useApp();
  const [name, setName] = useState(member.name);
  const [remark, setRemark] = useState(member.remark);
  const [photoOpen, setPhotoOpen] = useState(false);

  async function act(action: () => Promise<void>, success: string) {
    try {
      await action();
      message.success(success);
      onSaved();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "保存失败");
    }
  }

  return (
    <Card>
      <Flex gap={16} align="center">
        <PersonAvatar person={member} size={56} />
        <Flex vertical gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {member.name}
          </Typography.Title>
          <Typography.Text type="secondary">{member.remark || "没有备注"}</Typography.Text>
        </Flex>
        {member.self && <Button onClick={() => setPhotoOpen(true)}>更换头像</Button>}
      </Flex>
      <Row gutter={16} style={{ marginTop: 24 }}>
        <Col xs={24} md={12}>
          <Form layout="vertical" requiredMark={false} onFinish={() => act(() => api.setMyName(name), "姓名已保存")}>
            <Form.Item label="姓名" extra={member.self ? "这是你自己，可以改姓名和头像。" : "只有管理员和他本人能改。"}>
              {member.self ? (
                <Space.Compact style={{ width: "100%" }}>
                  <Input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} />
                  <Button type="primary" htmlType="submit" disabled={!name.trim() || name.trim() === member.name}>
                    保存
                  </Button>
                </Space.Compact>
              ) : (
                <Input value={member.name} disabled />
              )}
            </Form.Item>
          </Form>
        </Col>
        <Col xs={24} md={12}>
          <Form
            layout="vertical"
            requiredMark={false}
            onFinish={() => act(() => api.setRemark(member.id, remark), remark.trim() ? "备注已保存" : "备注已删除")}
          >
            <Form.Item label="我的备注" extra="只有你自己看得到。写了备注，家庭优化大师等其他应用里给你显示的就是备注，不是姓名。">
              <Space.Compact style={{ width: "100%" }}>
                <Input value={remark} maxLength={200} placeholder="比如：老爸、宝贝" onChange={(e) => setRemark(e.target.value)} />
                <Button type="primary" htmlType="submit" disabled={remark.trim() === member.remark}>
                  保存
                </Button>
              </Space.Compact>
            </Form.Item>
          </Form>
        </Col>
      </Row>
      <Modal title="更换头像" open={photoOpen} footer={null} onCancel={() => setPhotoOpen(false)} width={360}>
        <MyPhoto name={member.name} photo={member.photo} onChange={onSaved} />
      </Modal>
    </Card>
  );
}

// AdminUsers 是管理员看到的：左边是成员列表（家庭成员，加上没关联成员的账号），右边是选中项的页签：资料、账号、权限。
// 一个账号最多属于一个成员，一个成员可以有多个账号，权限挂在账号上。
function AdminUsers({ me }: { me: User }) {
  const [persons, setPersons] = useState<Person[] | null>(null);
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Selection | null>(null);
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

  const accountsOf = (personId: number) => users?.filter((u) => u.personId === personId) ?? [];
  const unlinked = users?.filter((u) => u.personId === null) ?? [];
  const q = query.trim().toLowerCase();
  const match = (...texts: string[]) => !q || texts.some((t) => t.toLowerCase().includes(q));
  const shownPersons = (persons ?? []).filter((p) =>
    match(p.name, p.note, ...accountsOf(p.id).flatMap((u) => [u.username, u.displayName])),
  );
  const shownUnlinked = unlinked.filter((u) => match(u.username, u.displayName));
  const isSelected = (s: Selection) => selected?.kind === s.kind && selected.id === s.id;
  const currentPerson = selected?.kind === "person" ? persons?.find((p) => p.id === selected.id) : undefined;
  const currentUser = selected?.kind === "user" ? users?.find((u) => u.id === selected.id) : undefined;

  const list = (
    <Card
      title="成员"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
          添加
        </Button>
      }
      styles={{ body: { padding: "0 0 8px" } }}
    >
      <SearchBox value={query} onChange={setQuery} placeholder="搜索姓名或用户名" />
      {error && <Alert type="error" message={error} showIcon style={{ margin: "0 16px 8px" }} />}
      {persons && shownPersons.length === 0 && shownUnlinked.length === 0 && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={q ? "没有找到" : "还没有成员，点“添加”开始。"} />
      )}
      {shownPersons.map((p) => {
        const s: Selection = { kind: "person", id: p.id };
        const accounts = accountsOf(p.id);
        return (
          <MemberRow
            key={`p${p.id}`}
            avatar={<PersonAvatar person={p} />}
            title={p.name}
            subtitle={accounts.length > 0 ? accounts.map((u) => u.username).join("、") : "没有账号"}
            tags={accountTags(accounts)}
            active={isSelected(s)}
            onClick={() => setSelected(s)}
          />
        );
      })}
      {shownUnlinked.length > 0 && (
        <Typography.Text type="secondary" className="member-group">
          未关联成员的账号
        </Typography.Text>
      )}
      {shownUnlinked.map((u) => {
        const s: Selection = { kind: "user", id: u.id };
        return (
          <MemberRow
            key={`u${u.id}`}
            avatar={<Avatar size={40} icon={<UserOutlined />} />}
            title={u.displayName}
            subtitle={u.username}
            tags={accountTags([u])}
            active={isSelected(s)}
            onClick={() => setSelected(s)}
          />
        );
      })}
    </Card>
  );

  const detail = currentPerson ? (
    <PersonDetail
      key={`p${currentPerson.id}`}
      person={currentPerson}
      accounts={accountsOf(currentPerson.id)}
      unlinked={unlinked}
      me={me}
      onSaved={load}
      onDeleted={() => {
        setSelected(null);
        load();
      }}
    />
  ) : currentUser && persons ? (
    <AccountDetail key={`u${currentUser.id}`} user={currentUser} persons={persons} me={me} onSaved={load} />
  ) : (
    <Card>
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择一个成员，查看他的资料、账号和权限。" />
    </Card>
  );

  return (
    <>
      <ListDetail list={list} detail={detail} selected={!!selected} onBack={() => setSelected(null)} />
      <Modal title="添加成员" open={adding} footer={null} onCancel={() => setAdding(false)} destroyOnHidden>
        <PersonForm
          submitText="添加"
          onSubmit={async (input) => {
            const p = await api.createPerson(input);
            setAdding(false);
            load();
            setSelected({ kind: "person", id: p.id });
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

function MemberRow({
  avatar,
  title,
  subtitle,
  tags,
  active,
  onClick,
}: {
  avatar: ReactNode;
  title: string;
  subtitle: string;
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
        <Typography.Text type="secondary" ellipsis>
          {subtitle}
        </Typography.Text>
      </Flex>
    </div>
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

function PersonDetail({
  person,
  accounts,
  unlinked,
  me,
  onSaved,
  onDeleted,
}: {
  person: Person;
  accounts: User[];
  unlinked: User[];
  me: User;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const { message } = AntApp.useApp();
  const [tab, setTab] = useState("profile");
  const [accountId, setAccountId] = useState<number | undefined>(accounts[0]?.id);
  const account = accounts.find((u) => u.id === accountId) ?? accounts[0];

  async function remove() {
    try {
      await api.deletePerson(person.id);
      onDeleted();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "删除失败");
    }
  }

  // 一个成员有多个账号时，账号和权限页签顶部用分段按钮切换。
  const picker = accounts.length > 1 && (
    <Segmented
      value={account?.id}
      onChange={(v) => setAccountId(v as number)}
      options={accounts.map((u) => ({ value: u.id, label: u.username }))}
      style={{ marginBottom: 16 }}
    />
  );

  return (
    <DetailCard
      avatar={<PersonAvatar person={person} size={56} />}
      title={person.name}
      subtitle={
        <Space size={6} wrap>
          {person.note && <span>{person.note}</span>}
          <span>{accounts.length > 0 ? `${accounts.length} 个账号` : "没有账号"}</span>
          {accountTags(accounts)}
        </Space>
      }
      extra={
        <Popconfirm
          title={`删除「${person.name}」？`}
          description="其他应用里此人的数据（如分数）将不再显示；他的账号会保留，只是不再关联成员。"
          okText="删除"
          okButtonProps={{ danger: true }}
          cancelText="取消"
          onConfirm={remove}
        >
          <Button type="text" danger>
            删除
          </Button>
        </Popconfirm>
      }
      tab={tab}
      onTab={setTab}
      items={[
        {
          key: "profile",
          label: "资料",
          children: (
            <PersonForm
              initial={person}
              submitText="保存"
              onSubmit={async (input) => {
                await api.updatePerson(person.id, input);
                message.success("已保存");
                onSaved();
              }}
            />
          ),
        },
        {
          key: "account",
          label: "账号",
          children: (
            <>
              {picker}
              {account && (
                <AccountSettings
                  key={account.id}
                  user={account}
                  me={me}
                  onSaved={onSaved}
                  link={
                    <Popconfirm
                      title={`解除账号 ${account.username} 和「${person.name}」的关联？`}
                      description="账号本身不会删除，会出现在“未关联成员的账号”里。"
                      okText="解除"
                      cancelText="取消"
                      onConfirm={() =>
                        api
                          .setUserPerson(account.id, null)
                          .then(() => {
                            message.success("已解除关联");
                            onSaved();
                          })
                          .catch((err) => message.error(err.message))
                      }
                    >
                      <Button danger>解除关联</Button>
                    </Popconfirm>
                  }
                />
              )}
              <AddAccount
                person={person}
                unlinked={unlinked}
                first={accounts.length === 0}
                onAdded={(id) => {
                  setAccountId(id);
                  onSaved();
                }}
              />
            </>
          ),
        },
        {
          key: "perms",
          label: "权限",
          children: account ? (
            <>
              {picker}
              <AppPermissions key={account.id} user={account} />
            </>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有账号，开通账号后才能设置权限。">
              <Button onClick={() => setTab("account")}>去开通账号</Button>
            </Empty>
          ),
        },
      ]}
    />
  );
}

// AccountDetail 是没关联成员的账号：可以把它关联到一个成员。
function AccountDetail({ user, persons, me, onSaved }: { user: User; persons: Person[]; me: User; onSaved: () => void }) {
  const { message } = AntApp.useApp();
  const [tab, setTab] = useState("account");
  return (
    <DetailCard
      avatar={<Avatar size={56} icon={<UserOutlined />} />}
      title={user.displayName}
      subtitle={
        <Space size={6} wrap>
          <span>{user.username}</span>
          {accountTags([user])}
        </Space>
      }
      tab={tab}
      onTab={setTab}
      items={[
        {
          key: "account",
          label: "账号",
          children: (
            <AccountSettings
              user={user}
              me={me}
              onSaved={onSaved}
              link={
                <Select
                  placeholder="关联到成员"
                  style={{ minWidth: 160 }}
                  onChange={(id: number) =>
                    api
                      .setUserPerson(user.id, id)
                      .then(() => {
                        message.success("已关联");
                        onSaved();
                      })
                      .catch((err) => message.error(err.message))
                  }
                  options={persons.map((p) => ({ value: p.id, label: p.name }))}
                />
              }
            />
          ),
        },
        { key: "perms", label: "权限", children: <AppPermissions user={user} /> },
      ]}
    />
  );
}

type CreateForm = { username: string; displayName?: string; password: string; confirm: string; admin: boolean };

// 设置密码时要输入两次：passwordRules 校验长度，confirmRules 校验和 password 字段一致。
const passwordRules = [
  { required: true, message: "请输入密码" },
  { min: 8, message: "密码至少 8 位" },
];
const confirmRules = [
  { required: true, message: "请再输入一次密码" },
  ({ getFieldValue }: { getFieldValue: (name: string) => unknown }) => ({
    validator: (_: unknown, value: string) =>
      !value || value === getFieldValue("password") ? Promise.resolve() : Promise.reject(new Error("两次输入的密码不一样")),
  }),
];

// AddAccount 给成员开通新账号或关联一个没关联成员的账号。还没有账号时直接摊开说明和两个按钮。
function AddAccount({
  person,
  unlinked,
  first,
  onAdded,
}: {
  person: Person;
  unlinked: User[];
  first: boolean;
  onAdded: (id: number) => void;
}) {
  const { message } = AntApp.useApp();
  const [adding, setAdding] = useState<"create" | "link" | null>(null);
  const [linkId, setLinkId] = useState<number | null>(null);
  const [form] = Form.useForm<CreateForm>();

  async function create(values: CreateForm) {
    try {
      const { confirm: _, ...input } = values;
      const u = await api.createUser({ ...input, displayName: values.displayName || person.name, personId: person.id });
      message.success("账号已开通");
      form.resetFields();
      setAdding(null);
      onAdded(u.id);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "开通失败");
    }
  }

  async function link() {
    try {
      await api.setUserPerson(linkId!, person.id);
      message.success("已关联");
      setAdding(null);
      onAdded(linkId!);
      setLinkId(null);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "关联失败");
    }
  }

  return (
    <div className={first ? undefined : "section"}>
      {first && (
        <Typography.Paragraph type="secondary">
          还没有账号。开通后他就能登录平台，其他应用也能知道登录的是他。
        </Typography.Paragraph>
      )}
      <Space wrap>
        <Button icon={<PlusOutlined />} type={first ? "primary" : "default"} onClick={() => setAdding(adding === "create" ? null : "create")}>
          {first ? "开通账号" : "再开通一个账号"}
        </Button>
        <Button onClick={() => setAdding(adding === "link" ? null : "link")}>关联已有账号</Button>
      </Space>

      {adding === "create" && (
        <Form form={form} layout="vertical" requiredMark={false} initialValues={{ admin: false }} onFinish={create} style={{ marginTop: 16 }}>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item label="用户名（登录用）" name="username" rules={[{ required: true, message: "请输入用户名" }]}>
                <Input autoCapitalize="none" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="显示名称" name="displayName">
                <Input placeholder={`不填则用“${person.name}”`} />
              </Form.Item>
            </Col>
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
            <Typography.Text type="secondary">所有账号都已经关联了成员。</Typography.Text>
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
              <Button type="primary" disabled={linkId === null} onClick={link}>
                关联
              </Button>
            </>
          )}
          <Button onClick={() => setAdding(null)}>取消</Button>
        </Flex>
      )}
    </div>
  );
}

// AccountSettings 是一个账号的显示名称、管理员、停用和重置密码；link 是关联或解除关联成员的操作。
// 开关和权限页签一样拨动即保存，显示名称要点“保存”。
function AccountSettings({ user, me, onSaved, link }: { user: User; me: User; onSaved: () => void; link: ReactNode }) {
  const { message } = AntApp.useApp();
  const isMe = user.id === me.id;
  const [displayName, setDisplayName] = useState(user.displayName);
  const [admin, setAdmin] = useState(isAdmin(user));
  const [disabled, setDisabled] = useState(user.disabled);
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

  // 拨动开关立即保存，显示名称用已保存的值；失败时开关退回原样。
  async function toggle(next: { admin: boolean; disabled: boolean }, success: string) {
    const prev = { admin, disabled };
    setAdmin(next.admin);
    setDisabled(next.disabled);
    if (!(await act(() => api.updateUser(user.id, { displayName: user.displayName, ...next }), success))) {
      setAdmin(prev.admin);
      setDisabled(prev.disabled);
    }
  }

  return (
    <Flex vertical gap={0}>
      <Form layout="vertical" requiredMark={false} onFinish={() => act(() => api.updateUser(user.id, { displayName, admin, disabled }), "显示名称已保存")}>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item label="用户名">
              <Input value={user.username} disabled />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item label="显示名称" required>
              <Space.Compact style={{ width: "100%" }}>
                <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
                <Button type="primary" htmlType="submit" disabled={displayName.trim() === user.displayName}>
                  保存
                </Button>
              </Space.Compact>
            </Form.Item>
          </Col>
        </Row>
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

      <div className="section">
        <Typography.Text strong>所属成员</Typography.Text>
        <div style={{ marginTop: 8 }}>{link}</div>
      </div>
    </Flex>
  );
}

// SwitchRow 是一行开关：左边是名称和说明，右边是开关。账号设置和权限都用它。
function SwitchRow({
  title,
  description,
  checked,
  disabled,
  onChange,
  extra,
}: {
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  extra?: ReactNode;
}) {
  return (
    <Flex align="center" gap={12} className="switch-row">
      <Flex vertical style={{ flex: 1, minWidth: 0 }}>
        <Typography.Text>{title}</Typography.Text>
        {description && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {description}
          </Typography.Text>
        )}
      </Flex>
      {extra}
      <Switch checked={checked} disabled={disabled} onChange={onChange} />
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
    !admin &&
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
        disabled={admin || !m.access.allowed}
        onChange={() => toggle(kind, m.id, g)}
        extra={reset(kind, m.id, g)}
      />
    ));

  return (
    <Flex vertical gap={12}>
      <Typography.Text type="secondary">
        {admin
          ? "管理员拥有全部权限，不能单独修改。"
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
