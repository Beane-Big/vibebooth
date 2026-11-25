import { useCallback, useEffect, useState } from "react";
import { Button, Card, Col, Flex, Row, Space, Tag, Typography } from "antd";
import {
  ArrowRightOutlined,
  CheckCircleFilled,
  CloseOutlined,
  CompassOutlined,
} from "@ant-design/icons";
import { isAdmin, type Me } from "../api";
import { useSiteInfo } from "../site";

type StoredState = {
  dismissed: boolean;
  done: string[];
};

const storageKey = (userId: number) => `vb:onboarding:${userId}`;

function readState(userId: number): StoredState {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return { dismissed: false, done: [] };
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return {
      dismissed: parsed.dismissed === true,
      done: Array.isArray(parsed.done) ? parsed.done.filter((x): x is string => typeof x === "string") : [],
    };
  } catch {
    return { dismissed: false, done: [] };
  }
}

function writeState(userId: number, state: StoredState) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(state));
  } catch {}
}

export function useOnboarding(userId: number) {
  const [state, setState] = useState<StoredState>(() => readState(userId));

  useEffect(() => {
    setState(readState(userId));
  }, [userId]);

  const dismiss = useCallback(() => {
    setState((prev) => {
      const next = { ...prev, dismissed: true };
      writeState(userId, next);
      return next;
    });
  }, [userId]);

  const reopen = useCallback(() => {
    setState((prev) => {
      const next = { ...prev, dismissed: false };
      writeState(userId, next);
      return next;
    });
  }, [userId]);

  const markDone = useCallback(
    (stepId: string) => {
      setState((prev) => {
        if (prev.done.includes(stepId)) return prev;
        const next = { ...prev, done: [...prev.done, stepId] };
        writeState(userId, next);
        return next;
      });
    },
    [userId],
  );

  const toggleDone = useCallback(
    (stepId: string) => {
      setState((prev) => {
        const exists = prev.done.includes(stepId);
        const next = {
          ...prev,
          done: exists ? prev.done.filter((id) => id !== stepId) : [...prev.done, stepId],
        };
        writeState(userId, next);
        return next;
      });
    },
    [userId],
  );

  return { state, dismiss, reopen, markDone, toggleDone };
}

type StepDef = {
  id: string;
  title: string;
  desc: string;
  action: string;
  link: string;
  autoDone?: boolean;
};

export default function OnboardingGuide({
  user,
  hasModules,
  doneIds,
  onNavigate,
  onMarkDone,
  onToggleDone,
  onDismiss,
}: {
  user: Me;
  hasModules: boolean;
  doneIds: string[];
  onNavigate: (link: string) => void;
  onMarkDone: (id: string) => void;
  onToggleDone: (id: string) => void;
  onDismiss: () => void;
}) {
  const site = useSiteInfo();
  const admin = isAdmin(user);

  const steps: StepDef[] = admin
    ? [
        {
          id: "password",
          title: "修改初始密码与资料",
          desc: "设置头像、姓名并修改默认密码",
          action: "去修改",
          link: "/contacts/self",
        },
        {
          id: "site",
          title: "定制站点与消息推送",
          desc: "自定义产品名称、Logo 与离线推送通道",
          action: "去设置",
          link: "/settings",
          autoDone: site.name !== "Vibebooth" || site.hasLogo,
        },
        {
          id: "dev",
          title: "开发并上架第一个应用",
          desc: "下载开发 Skill，用 AI 生成应用并一键部署",
          action: "开始开发",
          link: "/applications/dev",
          autoDone: hasModules,
        },
        {
          id: "members",
          title: "添加成员与分配权限",
          desc: "新建账号或好友并按需开通应用",
          action: "去管理",
          link: "/contacts/accounts",
        },
      ]
    : [
        {
          id: "password",
          title: "完善资料与密码",
          desc: "设置姓名、头像或修改登录密码",
          action: "去设置",
          link: "/contacts/self",
        },
        {
          id: "contacts",
          title: "添加好友联系人",
          desc: "通过账号或邮箱添加家人与朋友",
          action: "去添加",
          link: "/contacts",
        },
        {
          id: "appearance",
          title: "切换外观与壁纸",
          desc: "在「外观」挑选喜欢的主题与壁纸",
          action: "选外观",
          link: "/themes",
        },
      ];

  const completed = steps.filter((s) => s.autoDone || doneIds.includes(s.id)).length;

  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={
        <Space size={8}>
          <CompassOutlined />
          <span>快速开始</span>
          <Tag color={completed === steps.length ? "success" : "blue"}>
            {completed}/{steps.length}
          </Tag>
        </Space>
      }
      extra={
        <Button type="text" size="small" icon={<CloseOutlined />} onClick={onDismiss}>
          不再显示
        </Button>
      }
    >
      <Row gutter={[12, 12]}>
        {steps.map((step, idx) => {
          const isDone = Boolean(step.autoDone || doneIds.includes(step.id));
          return (
            <Col xs={24} sm={12} lg={admin ? 6 : 8} key={step.id}>
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "12px 14px",
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  gap: 10,
                  opacity: isDone ? 0.72 : 1,
                }}
              >
                <Flex align="flex-start" gap={8}>
                  <button
                    type="button"
                    aria-label={isDone ? `取消完成 ${step.title}` : `标记完成 ${step.title}`}
                    onClick={() => onToggleDone(step.id)}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      marginTop: 2,
                      cursor: "pointer",
                      color: isDone ? "#22a06b" : "var(--muted)",
                      fontSize: 16,
                      lineHeight: 1,
                    }}
                  >
                    {isDone ? (
                      <CheckCircleFilled />
                    ) : (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 18,
                          height: 18,
                          borderRadius: "50%",
                          border: "1px solid currentColor",
                          fontSize: 11,
                        }}
                      >
                        {idx + 1}
                      </span>
                    )}
                  </button>
                  <div style={{ minWidth: 0 }}>
                    <Typography.Text strong delete={isDone} style={{ display: "block" }}>
                      {step.title}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {step.desc}
                    </Typography.Text>
                  </div>
                </Flex>
                <div>
                  <Button
                    size="small"
                    type={isDone ? "default" : "primary"}
                    icon={<ArrowRightOutlined />}
                    iconPosition="end"
                    onClick={() => {
                      onMarkDone(step.id);
                      onNavigate(step.link);
                    }}
                  >
                    {step.action}
                  </Button>
                </div>
              </div>
            </Col>
          );
        })}
      </Row>
    </Card>
  );
}
