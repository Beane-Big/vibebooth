import { useEffect, useState } from "react";
import { Alert, App, Button, Card, Empty, Flex, Form, Input, List, Space, Typography } from "antd";
import { api, type Contact } from "../api";
import ListDetail from "../components/ListDetail";
import PersonAvatar from "../components/PersonAvatar";

type AddContact = { identifier: string };

export default function Contacts() {
  const { message } = App.useApp();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [form] = Form.useForm<AddContact>();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = contacts?.find((contact) => contact.id === selectedId);

  async function load() {
    try {
      setContacts(await api.contacts());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取联系人失败");
    }
  }

  useEffect(() => { void load(); }, []);

  async function add({ identifier }: AddContact) {
    setBusy(true);
    try {
      await api.addContact(identifier);
      form.resetFields(["identifier"]);
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "添加失败");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setRemoving(id);
    try {
      await api.removeContact(id);
      setSelectedId(null);
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "移除失败");
    } finally {
      setRemoving(null);
    }
  }

  const list = (
    <Card title="联系人" size="small">
      <Form form={form} onFinish={add} disabled={busy || removing !== null}>
        <Space.Compact block>
          <Form.Item name="identifier" style={{ flex: 1, minWidth: 0 }} rules={[
            { required: true, whitespace: true, message: "请输入账号或邮箱" },
          ]}>
            <Input aria-label="账号或邮箱" placeholder="账号或邮箱" maxLength={254} autoCapitalize="none" spellCheck={false} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy}>添加</Button>
        </Space.Compact>
      </Form>
      {error && <Alert type="error" message={error} showIcon />}
      <List
        loading={contacts === null && !error}
        dataSource={contacts ?? []}
        rowKey="id"
        split={false}
        style={{ maxHeight: "min(62vh, 600px)", overflowY: "auto" }}
        locale={{ emptyText: "暂无联系人" }}
        renderItem={(contact) => (
          <List.Item style={{ padding: 0 }}>
            <button type="button"
              className={`member-row${selectedId === contact.id ? " active" : ""}`}
              style={{ border: 0, backgroundColor: selectedId === contact.id ? undefined : "transparent", color: "inherit", width: "100%", margin: 0, textAlign: "start" }}
              aria-pressed={selectedId === contact.id} onClick={() => setSelectedId(contact.id)}>
              <PersonAvatar person={{ name: contact.name, photo: "" }} size={36} />
              <Typography.Text strong ellipsis title={contact.name}>{contact.name}</Typography.Text>
            </button>
          </List.Item>
        )}
      />
    </Card>
  );

  const detail = (
    <Card style={{ minHeight: 260 }}>
      {selected ? (
        <Flex vertical gap={16}>
          <Flex align="center" gap={12}>
            <PersonAvatar person={{ name: selected.name, photo: "" }} size={52} />
            <Flex vertical style={{ minWidth: 0 }}>
              <Typography.Title level={4} style={{ margin: 0, overflowWrap: "anywhere" }}>{selected.name}</Typography.Title>
              {selected.username && selected.username !== selected.name && <Typography.Text type="secondary">{selected.username}</Typography.Text>}
            </Flex>
          </Flex>
          <Button danger style={{ alignSelf: "flex-start" }} loading={removing === selected.id}
            disabled={busy} onClick={() => remove(selected.id)}>移除联系人</Button>
        </Flex>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择联系人" />
      )}
    </Card>
  );
  return <ListDetail list={list} detail={detail} selected={!!selected} onBack={() => setSelectedId(null)}
    backLabel="联系人" listWidth={296} />;
}
