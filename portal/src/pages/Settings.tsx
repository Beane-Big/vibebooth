import { useEffect, useState } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Empty,
  Flex,
  Form,
  Grid,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
  Upload,
} from "antd";
import {
  BellOutlined,
  CloudSyncOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  DownloadOutlined,
  HistoryOutlined,
  LoadingOutlined,
  PlusOutlined,
  SendOutlined,
  SettingOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import {
  api,
  isAdmin,
  notifyAppsChanged,
  type BackupRecord,
  type BackupSettings,
  type BackupStatus,
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

const weekdayOptions = [
  { value: 0, label: "周日" },
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
];

const hourOptions = Array.from({ length: 24 }, (_, h) => ({
  value: h,
  label: `${String(h).padStart(2, "0")}:00`,
}));

export default function Settings({ me, entryPath }: { me: Me; entryPath?: string }) {
  const admin = isAdmin(me);
  const screens = Grid.useBreakpoint();
  const [activeKey, setActiveKey] = useState(() => {
    if (admin && entryPath === "/settings/backup") return "backup";
    return admin ? "site" : "notifications";
  });

  useEffect(() => {
    if (admin && entryPath === "/settings/backup") {
      setActiveKey("backup");
    }
  }, [admin, entryPath]);

  const items = [
    ...(admin
      ? [
          {
            key: "site",
            label: (
              <Space size={6}>
                <SettingOutlined />
                <span>站点</span>
              </Space>
            ),
            children: <SiteSettings />,
          },
        ]
      : []),
    {
      key: "notifications",
      label: (
        <Space size={6}>
          <BellOutlined />
          <span>消息推送</span>
        </Space>
      ),
      children: <NotificationSettings admin={admin} />,
    },
    ...(admin
      ? [
          {
            key: "backup",
            label: (
              <Space size={6}>
                <CloudSyncOutlined />
                <span>数据备份</span>
              </Space>
            ),
            children: <BackupSettingsPanel />,
          },
        ]
      : []),
  ];

  return (
    <Tabs
      tabPosition={screens.md ? "left" : "top"}
      activeKey={activeKey}
      onChange={setActiveKey}
      items={items}
    />
  );
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
              extra="选“管理员系统通知”后，构建结果、数据备份及应用发给管理员的提醒都会推到此通道。"
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

const triggerLabel: Record<string, { text: string; color?: string }> = {
  manual: { text: "手动", color: "blue" },
  scheduled: { text: "定时", color: "green" },
  "pre-restore": { text: "恢复前快照", color: "orange" },
};

function BackupSettingsPanel() {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<BackupSettings>();
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [items, setItems] = useState<BackupRecord[]>([]);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingDav, setTestingDav] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<{ kind: "id"; id: string; label: string } | { kind: "file"; file: File } | null>(null);
  const [adminPassword, setAdminPassword] = useState("");
  const [restoring, setRestoring] = useState(false);

  const watchedEnabled = Form.useWatch("enabled", form);
  const watchedFreq = Form.useWatch("frequency", form);
  const watchedDav = Form.useWatch("webdavEnabled", form);

  function loadList() {
    api
      .backups()
      .then((res) => {
        setItems(res.items);
        setStatus((prev) => {
          if (prev?.running && !res.status.running && prev.operation === "restore" && !res.status.lastError) {
            void notifyAppsChanged();
            message.success("数据恢复完成");
          }
          return res.status;
        });
      })
      .catch((err) => message.error(err instanceof Error ? err.message : "读取备份记录失败"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadList();
    api
      .backupSettings()
      .then((st) => {
        setSettings(st);
        form.setFieldsValue(st);
      })
      .catch((err) => message.error(err instanceof Error ? err.message : "读取备份设置失败"));
  }, [form]);

  useEffect(() => {
    if (!status?.running) return;
    const timer = setInterval(loadList, 2000);
    return () => clearInterval(timer);
  }, [status?.running]);

  async function startBackup() {
    try {
      await api.createBackup(form.getFieldValue("includeModules"));
      message.success("已开始备份");
      loadList();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "启动备份失败");
    }
  }

  async function saveSettings(values: BackupSettings) {
    setSaving(true);
    try {
      const saved = await api.saveBackupSettings({
        ...values,
        webdavPasswordSet: settings?.webdavPasswordSet,
      });
      setSettings(saved);
      form.setFieldsValue({ ...saved, webdavPassword: "" });
      message.success("已保存备份设置");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function testWebDAV() {
    const url = form.getFieldValue("webdavUrl") ?? "";
    const username = form.getFieldValue("webdavUsername") ?? "";
    const password = form.getFieldValue("webdavPassword") ?? "";
    setTestingDav(true);
    try {
      await api.testBackupWebDAV({
        webdavUrl: url,
        webdavUsername: username,
        webdavPassword: password,
        useSavedPassword: Boolean(settings?.webdavPasswordSet && !password),
      });
      message.success("WebDAV 连接成功");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "连接失败");
    } finally {
      setTestingDav(false);
    }
  }

  async function deleteRecord(id: string) {
    try {
      await api.deleteBackup(id);
      setItems((prev) => prev.filter((x) => x.id !== id));
      message.success("已删除");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "删除失败");
    }
  }

  async function confirmRestore() {
    if (!restoreTarget) return;
    if (!adminPassword) {
      message.error("请输入管理员当前密码");
      return;
    }
    setRestoring(true);
    try {
      if (restoreTarget.kind === "id") {
        await api.restoreBackupById(restoreTarget.id, adminPassword);
      } else {
        await api.restoreBackupByFile(restoreTarget.file, adminPassword);
      }
      setRestoreTarget(null);
      setAdminPassword("");
      message.success("已开始恢复，请稍候…");
      loadList();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "恢复失败");
    } finally {
      setRestoring(false);
    }
  }

  const latest = items[0];
  const busy = Boolean(status?.running);

  return (
    <Flex vertical gap={16} style={{ maxWidth: 760 }}>
      <Alert
        type="info"
        showIcon
        message="数据备份说明"
        description="备份包含平台账号、联系人、站点设置、已安装主题以及勾选的应用数据卷，不包含可重新构建的镜像与构建缓存。恢复前会自动创建一份保底快照。"
      />

      {status?.running && (
        <Alert
          type="info"
          showIcon
          icon={<LoadingOutlined spin />}
          message={status.operation === "restore" ? "正在恢复数据…" : "正在备份数据…"}
          description={status.phase || "请稍候"}
        />
      )}

      {!status?.running && status?.lastError && (
        <Alert type="error" showIcon message="最近一次任务失败" description={status.lastError} />
      )}

      <Card title="立即备份与恢复">
        <Flex vertical gap={12}>
          <Typography.Text type="secondary">
            {latest
              ? `最近备份：${formatTime(latest.createdAt)} · ${formatSize(latest.size)}${latest.webdavSynced ? " · 已同步 WebDAV" : ""}`
              : "还没有创建过备份"}
          </Typography.Text>
          <Space wrap>
            <Button type="primary" icon={<CloudUploadOutlined />} disabled={busy} onClick={startBackup}>
              立即备份
            </Button>
            <Upload
              accept=".gz,.tar.gz"
              showUploadList={false}
              disabled={busy}
              beforeUpload={(file) => {
                setAdminPassword("");
                setRestoreTarget({ kind: "file", file });
                return false;
              }}
            >
              <Button icon={<HistoryOutlined />} disabled={busy}>
                上传备份恢复
              </Button>
            </Upload>
          </Space>
        </Flex>
      </Card>

      <Card title="自动备份策略">
        <Form form={form} layout="vertical" onFinish={saveSettings}>
          <Form.Item name="enabled" label="开启定时自动备份" valuePropName="checked">
            <Switch />
          </Form.Item>
          {watchedEnabled && (
            <Space size={16} wrap>
              <Form.Item name="frequency" label="备份频率">
                <Select
                  style={{ width: 120 }}
                  options={[
                    { value: "daily", label: "每天" },
                    { value: "weekly", label: "每周" },
                  ]}
                />
              </Form.Item>
              {watchedFreq === "weekly" && (
                <Form.Item name="weekday" label="星期">
                  <Select style={{ width: 110 }} options={weekdayOptions} />
                </Form.Item>
              )}
              <Form.Item name="hour" label="执行时间">
                <Select style={{ width: 120 }} options={hourOptions} />
              </Form.Item>
            </Space>
          )}
          <Form.Item
            name="includeModules"
            label="同时备份已安装应用的数据卷"
            valuePropName="checked"
            extra="包含家庭记分、照片、背单词等各应用产生的数据。"
          >
            <Switch />
          </Form.Item>
          <Form.Item name="keepCount" label="服务器本地保留份数">
            <InputNumber min={1} max={90} />
          </Form.Item>

          <Form.Item
            name="webdavEnabled"
            label="异地同步到 WebDAV（可选）"
            valuePropName="checked"
            extra="支持坚果云、群晖/飞牛 NAS 或网盘 WebDAV，每次备份后自动多存一份到远端。"
          >
            <Switch />
          </Form.Item>
          {watchedDav && (
            <>
              <Form.Item
                name="webdavUrl"
                label="WebDAV 目录地址"
                rules={[{ required: true, message: "请输入 WebDAV 地址" }]}
              >
                <Input maxLength={512} />
              </Form.Item>
              <Form.Item name="webdavUsername" label="账号">
                <Input maxLength={128} />
              </Form.Item>
              <Form.Item
                name="webdavPassword"
                label="密码 / 应用密码"
                extra={settings?.webdavPasswordSet ? "已保存密码，留空表示保持不变。" : undefined}
              >
                <Input.Password maxLength={256} />
              </Form.Item>
              <Form.Item>
                <Button onClick={testWebDAV} loading={testingDav}>
                  测试连接
                </Button>
              </Form.Item>
            </>
          )}

          <Button type="primary" htmlType="submit" loading={saving}>
            保存设置
          </Button>
        </Form>
      </Card>

      <Card title="备份记录">
        <List
          loading={loading}
          dataSource={items}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无备份记录" /> }}
          renderItem={(rec) => {
            const tag = triggerLabel[rec.trigger] ?? { text: rec.trigger };
            return (
              <List.Item
                actions={[
                  <Button
                    key="dl"
                    size="small"
                    icon={<DownloadOutlined />}
                    href={api.backupDownloadUrl(rec.id)}
                  >
                    下载
                  </Button>,
                  <Button
                    key="restore"
                    size="small"
                    disabled={busy}
                    onClick={() => {
                      setAdminPassword("");
                      setRestoreTarget({ kind: "id", id: rec.id, label: formatTime(rec.createdAt) });
                    }}
                  >
                    恢复
                  </Button>,
                  <Popconfirm
                    key="del"
                    title="确定删除这条备份吗？"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => deleteRecord(rec.id)}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />} aria-label="删除备份" />
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space size={6} wrap>
                      <span>{formatTime(rec.createdAt)}</span>
                      <Tag color={tag.color}>{tag.text}</Tag>
                      {rec.includeModules && <Tag>含应用数据</Tag>}
                      {rec.webdavSynced && <Tag color="cyan">已同步 WebDAV</Tag>}
                      {rec.webdavError && <Tag color="warning">WebDAV 同步失败</Tag>}
                    </Space>
                  }
                  description={
                    <Typography.Text type="secondary">
                      {formatSize(rec.size)} · {rec.volumes.length} 个数据卷
                    </Typography.Text>
                  }
                />
              </List.Item>
            );
          }}
        />
      </Card>

      <Modal
        title="确认恢复数据"
        open={restoreTarget !== null}
        onCancel={() => {
          setRestoreTarget(null);
          setAdminPassword("");
        }}
        onOk={confirmRestore}
        confirmLoading={restoring}
        okText="确认恢复"
        okButtonProps={{ danger: true }}
        cancelText="取消"
      >
        <Flex vertical gap={12}>
          <Alert
            type="warning"
            showIcon
            message={
              restoreTarget?.kind === "id"
                ? `即将恢复 ${restoreTarget.label} 的备份`
                : `即将从文件 ${restoreTarget?.file.name ?? ""} 恢复`
            }
            description="恢复会覆盖当前的数据库与数据卷。系统会先自动创建一份恢复前快照作为保底。"
          />
          <div>
            <Typography.Text style={{ display: "block", marginBottom: 6 }}>
              请输入管理员当前密码以确认：
            </Typography.Text>
            <Input.Password
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              onPressEnter={confirmRestore}
              autoFocus
            />
          </div>
        </Flex>
      </Modal>
    </Flex>
  );
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function formatSize(bytes: number) {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${Math.ceil(bytes / 1024)} KB`;
  return `${bytes} B`;
}
