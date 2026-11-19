import { useEffect, useState } from "react";
import { Alert, App, Button, Card, Empty, Form, Input, Space, Tag } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { api, isAdmin, userDisplayName, type Contact, type Me } from "../api";
import ListDetail from "../components/ListDetail";
import PersonAvatar from "../components/PersonAvatar";
import Users, { MemberDetail, MemberRow, SelfDetail } from "./Users";

// 合并后的唯一入口：管理员看统一的账号管理（Users），其他人看自己的联系人列表。
export default function Contacts({ me, onMeChanged }: { me: Me; onMeChanged: () => void }) {
  return isAdmin(me) ? <Users me={me} onMeChanged={onMeChanged} /> : <ContactList me={me} onMeChanged={onMeChanged} />;
}

// 显示名称优先级：备注 > 姓名 > 账号。
function contactDisplayName(c: Contact) {
  return c.remark.trim() || c.name.trim() || c.username;
}

function ContactList({ me, onMeChanged }: { me: Me; onMeChanged: () => void }) {
  const { message } = App.useApp();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number | "self" | null>(null);
  const [query, setQuery] = useState("");
  const [form] = Form.useForm<{ identifier: string }>();
  const current = contacts?.find((c) => c.id === selected);
  const q = query.trim().toLowerCase();
  const shown = contacts?.filter((c) => [c.name, c.username, c.remark].some((v) => v.toLowerCase().includes(q))) ?? [];

  async function load() {
    try {
      setContacts(await api.contacts());
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
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "添加失败");
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
      <MemberRow avatar={<PersonAvatar person={{ name: userDisplayName(me), photo: me.photo }} />} title={userDisplayName(me)} subtitle="我的账号" tags={<Tag color="blue">我</Tag>} active={selected === "self"} onClick={() => setSelected("self")} />
      <div style={{ maxHeight: "min(62vh, 600px)", overflowY: "auto" }}>
        {shown.map((c) => (
          <MemberRow
            key={c.id}
            avatar={<PersonAvatar person={c} />}
            title={contactDisplayName(c)}
            subtitle={c.username === contactDisplayName(c) ? undefined : c.username}
            active={selected === c.id}
            onClick={() => setSelected(c.id)}
          />
        ))}
        {contacts && shown.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={q ? "没有找到" : "暂无联系人"} />}
      </div>
    </Card>
  );

  const detail =
    selected === "self" ? (
      <SelfDetail key="self" member={{ id: me.id, name: userDisplayName(me), photo: me.photo, remark: "", self: true }} onSaved={() => { void load(); onMeChanged(); }} />
    ) : current ? (
      <MemberDetail key={current.id} contact={current} onSaved={() => void load()} onRemove={() => remove(current.id)} />
    ) : (
      <Card><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择联系人" /></Card>
    );

  return <ListDetail list={list} detail={detail} selected={selected === "self" || !!current} onBack={() => setSelected(null)} backLabel="联系人" listWidth={296} />;
}
