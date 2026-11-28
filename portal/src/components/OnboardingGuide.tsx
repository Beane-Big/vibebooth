import { useCallback, useEffect, useRef, useState } from "react";
import { App as AntApp, Button, Card, Col, Flex, Row, Space, Tag, Typography } from "antd";
import {
  ArrowRightOutlined,
  CheckCircleFilled,
  CloseOutlined,
  CompassOutlined,
} from "@ant-design/icons";
import { api, isAdmin, type Me, type OnboardingState } from "../api";
import { useSiteInfo } from "../site";

const legacyStorageKey = (userId: number) => `vb:onboarding:${userId}`;

function normalizeState(raw?: Partial<OnboardingState> | null): OnboardingState {
  return {
    dismissed: raw?.dismissed === true,
    done: Array.isArray(raw?.done)
      ? Array.from(new Set(raw.done.filter((x): x is string => typeof x === "string" && x.trim() !== "")))
      : [],
  };
}

function readLegacyState(userId: number): OnboardingState | null {
  try {
    const raw = localStorage.getItem(legacyStorageKey(userId));
    if (!raw) return null;
    return normalizeState(JSON.parse(raw) as Partial<OnboardingState>);
  } catch {
    return null;
  }
}

function removeLegacyState(userId: number) {
  try {
    localStorage.removeItem(legacyStorageKey(userId));
  } catch {}
}

function mergeLegacy(
  server: OnboardingState,
  legacy: OnboardingState | null,
): { merged: OnboardingState; changed: boolean } {
  if (!legacy) return { merged: server, changed: false };
  const dismissed = server.dismissed || legacy.dismissed;
  const done = Array.from(new Set([...server.done, ...legacy.done]));
  const changed = dismissed !== server.dismissed || done.length !== server.done.length;
  return { merged: { dismissed, done }, changed };
}

export function useOnboarding(userId: number, serverState?: OnboardingState) {
  const { message } = AntApp.useApp();
  const server = normalizeState(serverState);
  const serverRef = useRef(server);
  serverRef.current = server;

  const [state, setState] = useState<OnboardingState>(() => mergeLegacy(server, readLegacyState(userId)).merged);
  // 已关闭后通过菜单再次查看仅临时展开，不把后端 dismissed 改回 false，刷新或下次进入不会再自动打开。
  const [manualOpen, setManualOpen] = useState(false);

  const stateRef = useRef(state);
  stateRef.current = state;
  const epochRef = useRef(0);
  const pendingRef = useRef(0);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  const enqueueSave = useCallback(
    (
      targetEpoch: number,
      patch: Partial<OnboardingState>,
      options?: { silent?: boolean; onSuccess?: () => void },
    ) => {
      pendingRef.current += 1;
      queueRef.current = queueRef.current
        .catch(() => {})
        .then(() => api.saveOnboarding(patch))
        .then((saved) => {
          options?.onSuccess?.();
          if (epochRef.current === targetEpoch && pendingRef.current === 1) {
            const next = normalizeState(saved);
            stateRef.current = next;
            setState(next);
          }
        })
        .catch((err) => {
          if (epochRef.current !== targetEpoch) return;
          if (!options?.silent) {
            message.error(err instanceof Error ? err.message : "保存新手引导状态失败");
          }
          if (pendingRef.current === 1) {
            api
              .onboarding()
              .then((fresh) => {
                if (epochRef.current === targetEpoch) {
                  const next = normalizeState(fresh);
                  stateRef.current = next;
                  setState(next);
                }
              })
              .catch(() => {});
          }
        })
        .finally(() => {
          if (epochRef.current === targetEpoch) {
            pendingRef.current = Math.max(0, pendingRef.current - 1);
          }
        });
    },
    [message],
  );

  // 登录或切换账号时，以当前用户在服务端保存的状态为准，并将早期浏览器本地记录一次性迁移到后端。
  useEffect(() => {
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    pendingRef.current = 0;
    setManualOpen(false);

    const legacy = readLegacyState(userId);
    const { merged, changed } = mergeLegacy(serverRef.current, legacy);
    stateRef.current = merged;
    setState(merged);

    if (legacy) {
      if (changed) {
        enqueueSave(epoch, merged, {
          silent: true,
          onSuccess: () => removeLegacyState(userId),
        });
      } else {
        removeLegacyState(userId);
      }
    }
  }, [userId, enqueueSave]);

  const serverDismissed = server.dismissed;
  const serverDoneKey = server.done.join("\0");
  useEffect(() => {
    if (pendingRef.current > 0) return;
    setState((prev) => {
      const next: OnboardingState = {
        dismissed: prev.dismissed || serverDismissed,
        done: serverRef.current.done,
      };
      stateRef.current = next;
      return next;
    });
  }, [userId, serverDismissed, serverDoneKey]);

  const dismiss = useCallback(() => {
    setManualOpen(false);
    if (stateRef.current.dismissed) return;
    const next: OnboardingState = { ...stateRef.current, dismissed: true };
    stateRef.current = next;
    setState(next);
    enqueueSave(epochRef.current, { dismissed: true });
  }, [enqueueSave]);

  const reopen = useCallback(() => {
    setManualOpen(true);
  }, []);

  const markDone = useCallback(
    (stepId: string) => {
      if (stateRef.current.done.includes(stepId)) return;
      const nextDone = [...stateRef.current.done, stepId];
      const next: OnboardingState = { ...stateRef.current, done: nextDone };
      stateRef.current = next;
      setState(next);
      enqueueSave(epochRef.current, { done: nextDone });
    },
    [enqueueSave],
  );

  const toggleDone = useCallback(
    (stepId: string) => {
      const exists = stateRef.current.done.includes(stepId);
      const nextDone = exists
        ? stateRef.current.done.filter((id) => id !== stepId)
        : [...stateRef.current.done, stepId];
      const next: OnboardingState = { ...stateRef.current, done: nextDone };
      stateRef.current = next;
      setState(next);
      enqueueSave(epochRef.current, { done: nextDone });
    },
    [enqueueSave],
  );

  return {
    state,
    visible: !state.dismissed || manualOpen,
    dismiss,
    reopen,
    markDone,
    toggleDone,
  };
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
  hasCustomTheme,
  doneIds,
  dismissed = false,
  onNavigate,
  onMarkDone,
  onToggleDone,
  onDismiss,
}: {
  user: Me;
  hasModules: boolean;
  hasCustomTheme: boolean;
  doneIds: string[];
  dismissed?: boolean;
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
          id: "theme",
          title: "为自己定制主题外观",
          desc: "挑选主题壁纸，或用 AI 定制专属门户风格",
          action: "去定制",
          link: "/themes/dev",
          autoDone: hasCustomTheme,
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
          {dismissed ? "关闭" : "不再显示"}
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
