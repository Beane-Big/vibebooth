import { useEffect, useState } from "react";
import { Alert, App, Button, Card, Empty, Flex, Form, Input, Segmented, Space, Tag, Typography } from "antd";
import { SearchOutlined, UserAddOutlined } from "@ant-design/icons";
import { api, isAdmin, userDisplayName, type Contact, type ContactRequest, type Me } from "../api";
import ListDetail from "../components/ListDetail";
import PersonAvatar from "../components/PersonAvatar";
import Users, { MemberDetail, MemberRow, SelfDetail } from "./Users";

// 合并后的唯一入口：管理员可在“我的联系人”与“账号管理”之间切换；普通用户只看自己的联系人列表。
export default function Contacts({ me, onMeChanged }: { me: Me; onMeChanged: () => void }) {
  const [mode, setMode] = useState<"contacts" | "accounts">("contacts");
  if (!isAdmin(me)) return <ContactList me={me} onMeChanged={onMeChanged} />;
  return (
    <Flex vertical gap={12}>
      <Segmented
        value={mode}
        onChange={(v) => setMode(v as "contacts" | "accounts")}
        options={[
          { label: "我的联系人", value: "contacts" },
          { label: "账号管理", value: "accounts" },
        ]}
        style={{ alignSelf: "flex-start" }}
      />
      {mode === "accounts" ? <Users me={me} onMeChanged={onMeChanged} /> : <ContactList me={me} onMeChanged={onMeChanged} />}
    </Flex>
  );
}

// 显示名称优先级：备注 > 姓名 > 账号。
function contactDisplayName(c: Contact) {
  return c.remark.trim() || c.name.trim() || c.username;
}

function requestDisplayName(r: ContactRequest) {
  return r.name.trim() || r.username;
}

function ContactList({ me, onMeChanged }: { me: Me; onMeChanged: () => void }) {
  const { message } = App.useApp();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [requests, setRequests] = useState<ContactRequest[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number | "self" | "requests" | null>(null);
  const [query, setQuery] = useState("");
  const [form] = Form.useForm<{ identifier: string }>();
  const current = typeof selected === "number" ? contacts?.find((c) => c.id === selected) : undefined;
  const q = query.trim().toLowerCase();
  const shown = contacts?.filter((c) => [c.name, c.username, c.remark].some((v) => v.toLowerCase().includes(q))) ?? [];

  async function load() {
    try {
      const [c, r] = await Promise.all([api.contacts(), api.contactRequests()]);
      setContacts(c);
      setRequests(r);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取联系人失败");
    }
  }
  useEffect(() => { void load(); }, []);

  async function add({ identifier }: { identifier: string }) {
    setBusy(true);
    try {
      await api.addContact(identifier);
      form.resetFields();
      message.success("已发送好友请求");
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "添加失败");
    } finally {
      setBusy(false);
    }
  }

  async function acceptRequest(id: number) {
    setBusy(true);
    try {
      await api.acceptContactRequest(id);
      message.success("已同意，双方互为好友");
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function rejectRequest(id: number) {
    setBusy(true);
    try {
      await api.rejectContactRequest(id);
      message.success("已拒绝该请求");
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setBusy(true);
    try {
      await api.removeContact(id);
      setSelected(null);
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "移除失败");
    } finally {
      setBusy(false);
    }
  }

  const list = (
    <Card title="联系人" loading={contacts === null && !error} styles={{ body: { padding: "0 0 8px" } }}>
      <Form form={form} onFinish={add} disabled={busy} style={{ padding: "0 16px" }}>
        <Space.Compact block>
          <Form.Item name="identifier" style={{ flex: 1, minWidth: 0 }} rules={[{ required: true, whitespace: true, message: "请输入账号或邮箱" }]}>
            <Input aria-label="账号或邮箱" placeholder="账号或邮箱" maxLength={254} autoCapitalize="none" spellCheck={false} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy}>添加</Button>
        </Space.Compact>
      </Form>
      <div style={{ padding: "0 16px 8px" }}>
        <Input aria-label="搜索联系人" allowClear prefix={<SearchOutlined />} placeholder="搜索姓名、账号或备注" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {error && <Alert type="error" message={error} showIcon style={{ margin: "0 16px 8px" }} />}
      {requests.length > 0 && (
        <MemberRow
          avatar={<UserAddOutlined style={{ fontSize: 18 }} />}
          title="新的好友请求"
          subtitle={`${requests.length} 位用户希望添加你为好友`}
          tags={<Tag color="red">{requests.length}</Tag>}
          active={selected === "requests"}
          onClick={() => setSelected("requests")}
        />
      )}
      <MemberRow avatar={<PersonAvatar person={{ name: userDisplayName(me), photo: me.photo }} />} title={userDisplayName(me)} subtitle="我的账号" tags={<Tag color="blue">我</Tag>} active={selected === "self"} onClick={() => setSelected("self")} />
      <div style={{ maxHeight: "min(62vh, 600px)", overflowY: "auto" }}>
        {shown.map((c) => (
          <MemberRow
            key={c.id}
            avatar={<PersonAvatar person={c} />}
            title={contactDisplayName(c)}
            subtitle={c.username === contactDisplayName(c) ? undefined : c.username}
            tags={c.status === "accepted" ? <Tag color="green">互为好友</Tag> : <Tag color="orange">待对方确认</Tag>}
            active={selected === c.id}
            onClick={() => setSelected(c.id)}
          />
        ))}
        {contacts && shown.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={q ? "没有找到" : "暂无联系人"} />}
      </div>
    </Card>
  );

  const detail =
    selected === "requests" ? (
      <Card title="好友请求">
        {requests.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待处理的好友请求" />
        ) : (
          <Flex vertical gap={12}>
            {requests.map((req) => (
              <Flex key={req.id} align="center" justify="space-between" gap={12} style={{ padding: "8px 0", borderBottom: "1px solid var(--ant-color-border-secondary)" }}>
                <Flex align="center" gap={12} style={{ minWidth: 0 }}>
                  <PersonAvatar person={{ name: requestDisplayName(req), photo: req.photo }} />
                  <Flex vertical style={{ minWidth: 0 }}>
                    <Typography.Text strong ellipsis>{requestDisplayName(req)}</Typography.Text>
                    {req.username !== requestDisplayName(req) && <Typography.Text type="secondary" ellipsis>{req.username}</Typography.Text>}
                  </Flex>
                </Flex>
                <Space>
                  <Button type="primary" size="small" loading={busy} onClick={() => acceptRequest(req.id)}>同意</Button>
                  <Button size="small" loading={busy} onClick={() => rejectRequest(req.id)}>拒绝</Button>
                </Space>
              </Flex>
            ))}
          </Flex>
        )}
      </Card>
    ) : selected === "self" ? (
      <SelfDetail key="self" member={{ id: me.id, name: userDisplayName(me), photo: me.photo, remark: "", self: true }} onSaved={() => { void load(); onMeChanged(); }} />
    ) : current ? (
      <MemberDetail key={current.id} contact={current} onSaved={() => void load()} onRemove={() => remove(current.id)} />
    ) : (
      <Card><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择联系人" /></Card>
    );

  return <ListDetail list={list} detail={detail} selected={selected === "self" || selected === "requests" || !!current} onBack={() => setSelected(null)} backLabel="联系人" listWidth={296} />;
}
