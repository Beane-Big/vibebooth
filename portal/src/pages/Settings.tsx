import { useEffect, useState } from "react";
import { Alert, App as AntApp, Button, Card, Empty, Flex, Form, Input, List, Modal, Select, Space, Switch, Tabs, Tag, Typography, Upload } from "antd";
import { DeleteOutlined, PlusOutlined, SendOutlined, UploadOutlined } from "@ant-design/icons";
import {
  api,
  isAdmin,
  type ChannelKind,
  type ChannelScope,
  type Me,
  type NotificationChannel,
} from "../api";
import { setSiteInfo, useSiteInfo } from "../site";

const channelKindLabel: Record<ChannelKind, string> = {
  bark: "Bark（iPhone 推送）",
  wecom: "企业微信群机器人",
  feishu: "飞书群机器人",
  dingtalk: "钉钉群机器人",
  webhook: "通用 Webhook",
};

const channelKindHelp: Record<ChannelKind, string> = {
  bark: "在 iPhone 安装免费 App「Bark」，打开首页直接复制推送链接粘贴到这里即可。",
  wecom: "在企业微信群右上角点「添加群机器人」，创建后复制 Webhook 地址。",
  feishu: "在飞书群「设置 → 群机器人 → 添加自定义机器人」，创建后复制 Webhook 地址。",
  dingtalk: "在钉钉群「设置 → 机器人 → 添加自定义机器人」，创建后复制 Webhook 地址。",
  webhook: "填写任意接收 JSON POST 请求的自定义推送地址。",
};

export default function Settings({ me }: { me: Me }) {
  const admin = isAdmin(me);
  const items = [
    ...(admin ? [{ key: "site", label: "站点", children: <SiteSettings /> }] : []),
    { key: "notifications", label: "消息推送", children: <NotificationSettings admin={admin} /> },
  ];
  return <Tabs defaultActiveKey={admin ? "site" : "notifications"} items={items} />;
}

function SiteSettings() {
  const { message } = AntApp.useApp();
  const site = useSiteInfo();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);

  useEffect(() => {
    form.setFieldsValue({
      name: site.name,
      icp: site.icp,
      police: site.police,
      terms: site.terms,
      privacy: site.privacy,
      allowRegistration: site.allowRegistration,
    });
  }, [site, form]);

  async function save(values: {
    name: string;
    icp: string;
    police: string;
    terms: string;
    privacy: string;
    allowRegistration: boolean;
  }) {
    setSaving(true);
    try {
      const updated = await api.updateSite(values);
      setSiteInfo(updated);
      message.success("已保存");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function uploadLogo(file: File) {
    setLogoBusy(true);
    try {
      const updated = await api.uploadSiteLogo(file);
      setSiteInfo(updated);
      message.success("已更新 Logo");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "上传失败");
    } finally {
      setLogoBusy(false);
    }
  }

  async function removeLogo() {
    setLogoBusy(true);
    try {
      const updated = await api.deleteSiteLogo();
      setSiteInfo(updated);
      message.success("已恢复默认");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setLogoBusy(false);
    }
  }

  return (
    <Flex vertical gap={16} style={{ maxWidth: 640 }}>
      <Card title="品牌与 Logo">
        <Flex align="center" gap={16} wrap style={{ marginBottom: 20 }}>
          {site.hasLogo && site.logoUrl ? (
            <img
              src={site.logoUrl}
              alt={site.name}
              style={{ height: 48, width: "auto", maxWidth: 160, objectFit: "contain", borderRadius: 8 }}
            />
          ) : (
            <Typography.Text strong style={{ fontSize: 18 }}>
              {site.name}
            </Typography.Text>
          )}
          <Space>
            <Upload
              accept=".png,.jpg,.jpeg,.webp,.svg"
              showUploadList={false}
              beforeUpload={(file) => {
                uploadLogo(file);
                return false;
              }}
            >
              <Button icon={<UploadOutlined />} loading={logoBusy}>
                上传 Logo
              </Button>
            </Upload>
            {site.hasLogo && (
              <Button onClick={removeLogo} disabled={logoBusy}>
                恢复默认
              </Button>
            )}
          </Space>
        </Flex>

        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="name" label="产品名称" rules={[{ max: 40, message: "不能超过 40 个字符" }]}>
            <Input maxLength={40} />
          </Form.Item>
          <Form.Item name="allowRegistration" label="开放自助注册" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="icp" label="ICP 备案号">
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item name="police" label="公安备案号">
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item name="terms" label="服务条款链接">
            <Input maxLength={512} />
          </Form.Item>
          <Form.Item name="privacy" label="隐私声明链接">
            <Input maxLength={512} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            保存
          </Button>
        </Form>
      </Card>
    </Flex>
  );
}

function NotificationSettings({ admin }: { admin: boolean }) {
  const { message } = AntApp.useApp();
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const watchedKind = (Form.useWatch("kind", form) as ChannelKind | undefined) ?? "bark";

  function load() {
    setLoading(true);
    api
      .notificationChannels()
      .then(setChannels)
      .catch((err) => message.error(err instanceof Error ? err.message : "加载失败"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function addChannel(values: { scope?: ChannelScope; kind: ChannelKind; name: string; targetUrl: string }) {
    setSaving(true);
    try {
      await api.createNotificationChannel({
        scope: admin && values.scope === "system" ? "system" : "user",
        kind: values.kind,
        name: values.name || "",
        targetUrl: values.targetUrl,
        enabled: true,
      });
      setModalOpen(false);
      form.resetFields();
      message.success("已添加");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "添加失败");
    } finally {
      setSaving(false);
    }
  }

  async function toggleChannel(ch: NotificationChannel, enabled: boolean) {
    try {
      const updated = await api.updateNotificationChannel(ch.id, { enabled });
      setChannels((prev) => prev.map((x) => (x.id === ch.id ? updated : x)));
    } catch (err) {
      message.error(err instanceof Error ? err.message : "更新失败");
    }
  }

  async function testChannel(ch: NotificationChannel) {
    setTestingId(ch.id);
    try {
      await api.testNotificationChannel(ch.id);
      message.success("测试推送已发送");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "测试失败");
    } finally {
      setTestingId(null);
    }
  }

  async function removeChannel(ch: NotificationChannel) {
    try {
      await api.deleteNotificationChannel(ch.id);
      setChannels((prev) => prev.filter((x) => x.id !== ch.id));
      message.success("已删除");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "删除失败");
    }
  }

  return (
    <Flex vertical gap={16} style={{ maxWidth: 720 }}>
      <Alert
        type="info"
        showIcon
        message="消息推送说明"
        description="打开网页时，顶栏小铃铛会实时弹出好友申请、构建结果及各应用的提醒；关闭网页离线时，重要消息会自动通过下方配置的通道发到你的手机或聊天群。不配置也不影响站内铃铛正常使用。"
      />
      <Card
        title="离线推送通道"
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              form.setFieldsValue({ scope: "user", kind: "bark", name: "", targetUrl: "" });
              setModalOpen(true);
            }}
          >
            添加通道
          </Button>
        }
      >
        <List
          loading={loading}
          dataSource={channels}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂未配置离线推送通道" /> }}
          renderItem={(ch) => (
            <List.Item
              actions={[
                <Switch key="en" size="small" checked={ch.enabled} onChange={(v) => toggleChannel(ch, v)} />,
                <Button
                  key="test"
                  size="small"
                  icon={<SendOutlined />}
                  loading={testingId === ch.id}
                  onClick={() => testChannel(ch)}
                >
                  测试
                </Button>,
                <Button
                  key="del"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label="删除通道"
                  onClick={() => removeChannel(ch)}
                />,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space size={6}>
                    <span>{ch.name || channelKindLabel[ch.kind]}</span>
                    <Tag>{channelKindLabel[ch.kind]}</Tag>
                    {ch.scope === "system" && <Tag color="blue">管理员系统通知</Tag>}
                  </Space>
                }
                description={<Typography.Text type="secondary" ellipsis>{ch.targetUrl}</Typography.Text>}
              />
            </List.Item>
          )}
        />
      </Card>

      <Modal
        title="添加推送通道"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" onFinish={addChannel}>
          {admin && (
            <Form.Item
              name="scope"
              label="接收范围"
              extra="选“管理员系统通知”后，构建结果及应用发给管理员的提醒都会推到此通道。"
            >
              <Select
                options={[
                  { value: "user", label: "仅本人消息" },
                  { value: "system", label: "管理员系统通知" },
                ]}
              />
            </Form.Item>
          )}
          <Form.Item name="kind" label="通道类型" rules={[{ required: true }]}>
            <Select
              options={Object.entries(channelKindLabel).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
          <Form.Item name="name" label="备注名称" rules={[{ max: 40, message: "不能超过 40 个字符" }]}>
            <Input maxLength={40} />
          </Form.Item>
          <Form.Item
            name="targetUrl"
            label="推送地址"
            extra={channelKindHelp[watchedKind]}
            rules={[
              { required: true, message: "请输入推送地址" },
              { type: "url", message: "请输入有效的 URL" },
            ]}
          >
            <Input maxLength={512} />
          </Form.Item>
        </Form>
      </Modal>
    </Flex>
  );
}
