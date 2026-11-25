import { useEffect, useRef, useState } from "react";
import { App as AntApp, Badge, Button, Empty, Flex, List, Popover, Spin, Typography } from "antd";
import { BellOutlined, CheckOutlined, DeleteOutlined } from "@ant-design/icons";
import { api, type NotificationItem } from "../api";

export default function NotificationBell({ onNavigate }: { onNavigate: (link: string) => void }) {
  const { notification } = AntApp.useApp();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  function loadList() {
    setLoading(true);
    api
      .notifications()
      .then((res) => {
        setItems(res.items);
        setUnreadCount(res.unreadCount);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    const es = new EventSource("/api/platform/notifications/stream");
    es.addEventListener("init", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { unreadCount: number };
        setUnreadCount(data.unreadCount ?? 0);
      } catch {}
    });
    es.addEventListener("unread", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { unreadCount: number };
        setUnreadCount(data.unreadCount ?? 0);
      } catch {}
    });
    es.addEventListener("notification", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { notification: NotificationItem; unreadCount: number };
        setUnreadCount(data.unreadCount ?? 0);
        const n = data.notification;
        setItems((prev) => [n, ...prev.filter((x) => x.id !== n.id)].slice(0, 50));
        notification.info({
          message: n.title,
          description: n.body || undefined,
          placement: "topRight",
          duration: 5,
          onClick: n.link
            ? () => {
                api.markNotificationRead(n.id).catch(() => {});
                setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
                onNavigateRef.current(n.link);
              }
            : undefined,
        });
      } catch {}
    });
    return () => es.close();
  }, [notification]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) loadList();
  }

  async function handleClickItem(item: NotificationItem) {
    if (!item.readAt) {
      setItems((prev) => prev.map((x) => (x.id === item.id ? { ...x, readAt: new Date().toISOString() } : x)));
      setUnreadCount((c) => Math.max(0, c - 1));
      api.markNotificationRead(item.id).catch(() => {});
    }
    if (item.link) {
      setOpen(false);
      onNavigate(item.link);
    }
  }

  async function handleReadAll() {
    setItems((prev) => prev.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() })));
    setUnreadCount(0);
    await api.markAllNotificationsRead().catch(() => {});
  }

  async function handleDelete(item: NotificationItem) {
    setItems((prev) => prev.filter((x) => x.id !== item.id));
    if (!item.readAt) setUnreadCount((c) => Math.max(0, c - 1));
    await api.deleteNotification(item.id).catch(() => {});
  }

  const content = (
    <div style={{ width: 340, maxWidth: "calc(100vw - 32px)" }}>
      <Flex align="center" justify="space-between" style={{ paddingBottom: 8 }}>
        <Typography.Text strong>消息通知</Typography.Text>
        {unreadCount > 0 && (
          <Button type="link" size="small" icon={<CheckOutlined />} onClick={handleReadAll}>
            全部已读
          </Button>
        )}
      </Flex>
      <div style={{ maxHeight: 380, overflowY: "auto" }}>
        {loading && items.length === 0 ? (
          <Flex justify="center" style={{ padding: 24 }}>
            <Spin size="small" />
          </Flex>
        ) : items.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无通知" style={{ margin: "16px 0" }} />
        ) : (
          <List
            size="small"
            dataSource={items}
            renderItem={(item) => (
              <List.Item
                style={{
                  padding: "8px 6px",
                  cursor: item.link ? "pointer" : "default",
                  opacity: item.readAt ? 0.65 : 1,
                }}
                onClick={() => handleClickItem(item)}
                actions={[
                  <Button
                    key="del"
                    type="text"
                    size="small"
                    aria-label="删除通知"
                    icon={<DeleteOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(item);
                    }}
                  />,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Flex align="center" gap={6}>
                      {!item.readAt && <Badge status="processing" />}
                      <Typography.Text strong={!item.readAt} ellipsis>
                        {item.title}
                      </Typography.Text>
                    </Flex>
                  }
                  description={
                    <div>
                      {item.body && (
                        <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ margin: "2px 0 4px", fontSize: 12 }}>
                          {item.body}
                        </Typography.Paragraph>
                      )}
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        {formatRelativeTime(item.createdAt)}
                      </Typography.Text>
                    </div>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </div>
    </div>
  );

  return (
    <Popover
      content={content}
      trigger="click"
      placement="bottomRight"
      open={open}
      onOpenChange={handleOpenChange}
    >
      <Button type="text" aria-label="消息通知" style={{ width: 40, height: 40, padding: 0 }}>
        <Badge count={unreadCount} size="small" offset={[2, -2]}>
          <BellOutlined style={{ fontSize: 18 }} />
        </Badge>
      </Button>
    </Popover>
  );
}

function formatRelativeTime(iso: string) {
  const ts = new Date(iso).getTime();
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}
