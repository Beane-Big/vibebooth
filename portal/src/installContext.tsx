import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, App as AntApp, Button, Flex, Modal, Space, Typography } from "antd";
import {
  api,
  ApiError,
  finalizeModuleInstall,
  privilegeInfo,
  type AppScope,
} from "./api";
import {
  api as builderApi,
  ApiError as BuilderApiError,
  notifyBuildsChanged,
  type Build,
} from "./pages/builder/api";
import { LogCollapse } from "./components/PackageUpload";
import type { InspectedZip } from "./zipInspect";

export type InstallPhase =
  | "queued"
  | "uploading"
  | "building"
  | "installing"
  | "confirm-privileges"
  | "completing";

export type InstallTask = {
  key: string;
  moduleId: string;
  name: string;
  version: string;
  description: string;
  iconUrl?: string;
  phase: InstallPhase;
  // 0 ~ 1，驱动 iOS 风格的扇形进度遮罩。
  progress: number;
  isUpgrade: boolean;
  buildId?: number;
  // 上传阶段用来在标签上展示上传百分比（0 ~ 1）。
  uploadFraction?: number;
  source: "drop" | "modules" | "builder";
};

type PrivilegePrompt = {
  key: string;
  name: string;
  privileges: string[];
  onConfirm: () => void;
  onCancel: () => void;
};

type FailurePrompt = {
  title: string;
  message: string;
  log?: string;
  buildId?: number;
};

type PackageInstallInput = {
  file: File;
  inspected: InspectedZip;
  scope?: AppScope;
  isUpgrade: boolean;
};

type SourceBuildInput = {
  file: File;
  inspected: InspectedZip;
  installAfter: boolean;
  scope?: AppScope;
  isUpgrade: boolean;
};

type ExternalTaskInput = {
  moduleId: string;
  name: string;
  version?: string;
  description?: string;
  iconUrl?: string;
  phase: InstallPhase;
  progress: number;
  isUpgrade?: boolean;
  buildId?: number;
  source: "modules" | "builder";
};

type InstallContextValue = {
  tasks: InstallTask[];
  taskByModuleId: (id?: string) => InstallTask | undefined;
  isModuleBusy: (id?: string) => boolean;
  startPackageInstall: (input: PackageInstallInput) => void;
  startSourceBuild: (input: SourceBuildInput) => Promise<void>;
  beginExternalTask: (input: ExternalTaskInput) => string;
  updateExternalTask: (key: string, patch: Partial<InstallTask>) => void;
  completeExternalTask: (key: string) => void;
  abortExternalTask: (key: string) => void;
};

const InstallContext = createContext<InstallContextValue | null>(null);

const COMPLETE_ANIM_MS = 720;
const SELF_ID = "builder";

let nextTaskSeq = 1;

function nextTaskKey() {
  return `vb-install-${nextTaskSeq++}`;
}

function revokeIfBlob(url?: string) {
  if (url && url.startsWith("blob:")) {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }
}

// 从 BuildKit 日志里粗略估算构建进度，让圆形进度条随构建步骤平滑前进。
function estimateBuildProgress(log: string, elapsedMs: number, prev: number): number {
  const doneMatches = log.match(/^#\d+\s+(?:DONE|CACHED)\b/gm);
  const stepMatches = log.match(/^#\d+\s+\[/gm);
  const doneCount = doneMatches ? doneMatches.length : 0;
  const totalHint = Math.max(stepMatches ? stepMatches.length : 0, doneCount + 2, 6);
  const stepRatio = doneCount / totalHint;
  // 按耗时平滑推进（约 90 秒趋近上限），和步骤进度取较大值，避免卡死不动。
  const timeRatio = 1 - Math.exp(-Math.max(0, elapsedMs) / 55000);
  const target = 0.16 + Math.min(1, Math.max(stepRatio * 0.85, timeRatio * 0.85)) * 0.48;
  return Math.min(0.64, Math.max(prev, target));
}

async function retrySaveInstall(id: number, ok: boolean, log: string, times: number) {
  for (let i = 1; ; i++) {
    try {
      await builderApi.saveInstall(id, ok, log);
      return;
    } catch (err) {
      if (i >= times) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export function InstallProvider({
  canManageAccess,
  onOpenBuild,
  children,
}: {
  canManageAccess: boolean;
  onOpenBuild: () => void;
  children: ReactNode;
}) {
  const { message } = AntApp.useApp();
  const [tasks, setTasks] = useState<InstallTask[]>([]);
  const [privilegePrompt, setPrivilegePrompt] = useState<PrivilegePrompt | null>(null);
  const [failurePrompt, setFailurePrompt] = useState<FailurePrompt | null>(null);

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  // 客户端串行队列：安装器一次只装一个模块，连续拖入多个包时按顺序执行，避免互相阻塞。
  const installerChainRef = useRef<Promise<void>>(Promise.resolve());
  const timersRef = useRef<Map<string, number>>(new Map());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const id of timersRef.current.values()) window.clearInterval(id);
      timersRef.current.clear();
    };
  }, []);

  const stopTimer = useCallback((key: string) => {
    const id = timersRef.current.get(key);
    if (id !== undefined) {
      window.clearInterval(id);
      timersRef.current.delete(key);
    }
  }, []);

  const patchTask = useCallback((key: string, change: Partial<InstallTask> | ((t: InstallTask) => Partial<InstallTask>)) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.key !== key) return t;
        const next = typeof change === "function" ? change(t) : change;
        return { ...t, ...next };
      }),
    );
  }, []);

  const removeTask = useCallback(
    (key: string) => {
      stopTimer(key);
      setTasks((prev) => {
        const target = prev.find((t) => t.key === key);
        if (target) revokeIfBlob(target.iconUrl);
        return prev.filter((t) => t.key !== key);
      });
    },
    [stopTimer],
  );

  // 播放 iOS 风格完成展开动效，再移除临时任务。
  const finishWithReveal = useCallback(
    (key: string) => {
      stopTimer(key);
      patchTask(key, { phase: "completing", progress: 1, uploadFraction: undefined });
      window.setTimeout(() => {
        if (mountedRef.current) removeTask(key);
      }, COMPLETE_ANIM_MS);
    },
    [patchTask, removeTask, stopTimer],
  );

  // 安装中阶段（docker load + up + healthcheck）：渐进逼近 0.94，让圆形遮罩持续自然推进。
  const startAsymptoticInstallProgress = useCallback(
    (key: string, floor: number) => {
      stopTimer(key);
      patchTask(key, (t) => ({ phase: "installing", progress: Math.max(t.progress, floor), uploadFraction: undefined }));
      const timer = window.setInterval(() => {
        patchTask(key, (t) => {
          if (t.phase !== "installing") return {};
          const next = t.progress + (0.94 - t.progress) * 0.065;
          return { progress: Math.min(0.94, next) };
        });
      }, 450);
      timersRef.current.set(key, timer);
    },
    [patchTask, stopTimer],
  );

  const enqueueInstaller = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const next = installerChainRef.current.then(fn, fn);
    installerChainRef.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }, []);

  const askPrivileges = useCallback(
    (key: string, name: string, privileges: string[]): Promise<boolean> => {
      stopTimer(key);
      patchTask(key, { phase: "confirm-privileges" });
      return new Promise((resolve) => {
        setPrivilegePrompt({
          key,
          name,
          privileges,
          onConfirm: () => {
            setPrivilegePrompt(null);
            resolve(true);
          },
          onCancel: () => {
            setPrivilegePrompt(null);
            resolve(false);
          },
        });
      });
    },
    [patchTask, stopTimer],
  );

  const startPackageInstall = useCallback(
    ({ file, inspected, scope, isUpgrade }: PackageInstallInput) => {
      const m = inspected.manifest;
      const key = nextTaskKey();
      const moduleId = m?.id || file.name.replace(/\.zip$/i, "");
      const name = m?.name || moduleId;
      const version = m?.version || "";
      const description = m?.description || "";

      setTasks((prev) => [
        ...prev,
        {
          key,
          moduleId,
          name,
          version,
          description,
          iconUrl: inspected.iconUrl,
          phase: "queued",
          progress: 0.02,
          isUpgrade,
          source: "drop",
        },
      ]);

      const runInstall = async (allowPrivileges: boolean): Promise<void> => {
        patchTask(key, { phase: "uploading", progress: 0.04, uploadFraction: 0 });
        try {
          const { module, log } = await api.installModule(file, allowPrivileges, (f) => {
            if (f < 1) {
              patchTask(key, {
                phase: "uploading",
                progress: 0.04 + f * 0.51,
                uploadFraction: f,
              });
            } else {
              startAsymptoticInstallProgress(key, 0.56);
            }
          });
          // 上传极快时 onProgress 可能直接到 1 或跳过，确保进入安装态。
          stopTimer(key);
          patchTask(key, {
            moduleId: module.id,
            name: module.name || name,
            version: module.version || version,
            description: module.description || description,
            progress: 0.96,
          });
          const { accessError } = await finalizeModuleInstall(
            module.id,
            module.version,
            canManageAccess ? scope : undefined,
          );
          finishWithReveal(key);
          if (accessError) {
            message.warning(`${module.name} 已${isUpgrade ? "更新" : "安装"}（权限范围设置失败：${accessError}）`);
          }
          void log;
        } catch (err) {
          stopTimer(key);
          if (err instanceof ApiError && err.status === 409 && err.privileges.length > 0 && !allowPrivileges) {
            const approved = await askPrivileges(key, name, err.privileges);
            if (approved) {
              await runInstall(true);
              return;
            }
            removeTask(key);
            return;
          }
          removeTask(key);
          setFailurePrompt({
            title: `${name} 安装失败`,
            message: err instanceof Error ? err.message : "安装失败",
            log: err instanceof ApiError ? err.log : undefined,
          });
        }
      };

      void enqueueInstaller(() => runInstall(false));
    },
    [
      askPrivileges,
      canManageAccess,
      enqueueInstaller,
      finishWithReveal,
      message,
      patchTask,
      removeTask,
      startAsymptoticInstallProgress,
      stopTimer,
    ],
  );

  const startSourceBuild = useCallback(
    async ({ file, inspected, installAfter, scope, isUpgrade }: SourceBuildInput) => {
      const m = inspected.manifest;
      const moduleId = m?.id || file.name.replace(/\.zip$/i, "");
      const name = m?.name || moduleId;
      const version = m?.version || "";
      const description = m?.description || "";

      if (!installAfter) {
        revokeIfBlob(inspected.iconUrl);
        try {
          const build = await builderApi.upload(file);
          notifyBuildsChanged();
          message.success(`${build.moduleName || name} 已加入构建队列`);
          onOpenBuild();
        } catch (err) {
          setFailurePrompt({
            title: `${name} 上传失败`,
            message: err instanceof Error ? err.message : "源码包上传失败",
          });
        }
        return;
      }

      const key = nextTaskKey();
      setTasks((prev) => [
        ...prev,
        {
          key,
          moduleId,
          name,
          version,
          description,
          iconUrl: inspected.iconUrl,
          phase: "uploading",
          progress: 0.03,
          uploadFraction: 0,
          isUpgrade,
          source: "drop",
        },
      ]);

      let build: Build;
      try {
        build = await builderApi.upload(file, true, (f) => {
          patchTask(key, {
            phase: "uploading",
            progress: 0.03 + f * 0.1,
            uploadFraction: f,
          });
        });
        notifyBuildsChanged();
      } catch (err) {
        removeTask(key);
        setFailurePrompt({
          title: `${name} 上传失败`,
          message: err instanceof Error ? err.message : "源码包上传失败",
        });
        return;
      }

      const realName = build.moduleName || name;
      patchTask(key, {
        moduleId: build.moduleId || moduleId,
        name: realName,
        version: build.version || version,
        buildId: build.id,
        phase: build.status === "building" ? "building" : "queued",
        progress: 0.14,
        uploadFraction: undefined,
      });

      const startedLocal = Date.now();
      let finalBuild: Build = build;

      // 轮询构建状态直到完成，同时按日志和耗时平滑更新圆形进度。
      while (mountedRef.current) {
        if (finalBuild.status === "success" || finalBuild.status === "failed") break;
        await new Promise((r) => setTimeout(r, 2500));
        if (!mountedRef.current) return;
        try {
          const detail = await builderApi.build(build.id);
          finalBuild = detail.build;
          if (finalBuild.status === "building") {
            const elapsedMs = finalBuild.startedAt
              ? Math.max(0, Date.now() - new Date(finalBuild.startedAt).getTime())
              : Date.now() - startedLocal;
            patchTask(key, (t) => ({
              phase: "building",
              progress: estimateBuildProgress(detail.log, elapsedMs, t.progress),
            }));
          } else if (finalBuild.status === "queued") {
            patchTask(key, { phase: "queued" });
          }
        } catch (err) {
          if (err instanceof BuilderApiError && err.status === 404) {
            removeTask(key);
            return;
          }
          // 网络抖动时继续下一轮轮询。
        }
      }

      notifyBuildsChanged();
      if (!mountedRef.current) return;

      if (finalBuild.status !== "success") {
        removeTask(key);
        setFailurePrompt({
          title: `${realName} 构建失败`,
          message: finalBuild.error || "构建未通过，请查看构建日志",
          buildId: finalBuild.id,
        });
        return;
      }

      // 构建成功，串行调用安装器完成安装。
      const installBuilt = async (allowPrivileges: boolean): Promise<void> => {
        startAsymptoticInstallProgress(key, 0.66);
        let ok = false;
        let log = "";
        try {
          const res = await builderApi.install(finalBuild, allowPrivileges);
          log = res.log;
          ok = true;
          stopTimer(key);
          patchTask(key, { progress: 0.96 });
          const targetId = res.module?.id ?? finalBuild.moduleId;
          const targetVersion = res.module?.version ?? finalBuild.version;
          const { accessError } = await finalizeModuleInstall(
            targetId,
            targetVersion,
            canManageAccess ? scope : undefined,
          );
          await retrySaveInstall(finalBuild.id, true, log, finalBuild.moduleId === SELF_ID ? 5 : 1).catch(() => {});
          notifyBuildsChanged();
          finishWithReveal(key);
          if (finalBuild.moduleId === SELF_ID) {
            message.success(`构建器已更新为 ${finalBuild.version}，刷新页面后生效`);
          } else if (accessError) {
            message.warning(`${realName} 已${isUpgrade ? "更新" : "安装"}（权限范围设置失败：${accessError}）`);
          }
        } catch (err) {
          stopTimer(key);
          if (err instanceof BuilderApiError && err.status === 409 && err.privileges.length > 0 && !allowPrivileges) {
            const approved = await askPrivileges(key, realName, err.privileges);
            if (approved) {
              await installBuilt(true);
              return;
            }
            removeTask(key);
            return;
          }
          if (err instanceof BuilderApiError) log = err.log;
          await retrySaveInstall(finalBuild.id, ok, log, 1).catch(() => {});
          notifyBuildsChanged();
          removeTask(key);
          setFailurePrompt({
            title: `${realName} 安装失败`,
            message: err instanceof Error ? err.message : "安装失败",
            log: log || undefined,
            buildId: finalBuild.id,
          });
        }
      };

      void enqueueInstaller(() => installBuilt(false));
    },
    [
      askPrivileges,
      canManageAccess,
      enqueueInstaller,
      finishWithReveal,
      message,
      onOpenBuild,
      patchTask,
      removeTask,
      startAsymptoticInstallProgress,
      stopTimer,
    ],
  );

  const beginExternalTask = useCallback((input: ExternalTaskInput) => {
    const key = nextTaskKey();
    setTasks((prev) => [
      ...prev,
      {
        key,
        moduleId: input.moduleId,
        name: input.name,
        version: input.version ?? "",
        description: input.description ?? "",
        iconUrl: input.iconUrl,
        phase: input.phase,
        progress: input.progress,
        isUpgrade: input.isUpgrade ?? false,
        buildId: input.buildId,
        source: input.source,
      },
    ]);
    return key;
  }, []);

  const updateExternalTask = useCallback(
    (key: string, change: Partial<InstallTask>) => {
      patchTask(key, change);
    },
    [patchTask],
  );

  const completeExternalTask = useCallback(
    (key: string) => {
      finishWithReveal(key);
    },
    [finishWithReveal],
  );

  const abortExternalTask = useCallback(
    (key: string) => {
      removeTask(key);
    },
    [removeTask],
  );

  const taskByModuleId = useCallback(
    (id?: string) => (id ? tasks.find((t) => t.moduleId === id) : undefined),
    [tasks],
  );

  const isModuleBusy = useCallback(
    (id?: string) => (id ? tasksRef.current.some((t) => t.moduleId === id && t.phase !== "completing") : false),
    [],
  );

  const value = useMemo<InstallContextValue>(
    () => ({
      tasks,
      taskByModuleId,
      isModuleBusy,
      startPackageInstall,
      startSourceBuild,
      beginExternalTask,
      updateExternalTask,
      completeExternalTask,
      abortExternalTask,
    }),
    [
      abortExternalTask,
      beginExternalTask,
      completeExternalTask,
      isModuleBusy,
      startPackageInstall,
      startSourceBuild,
      taskByModuleId,
      tasks,
      updateExternalTask,
    ],
  );

  return (
    <InstallContext.Provider value={value}>
      {children}
      <Modal
        open={Boolean(privilegePrompt)}
        title={privilegePrompt ? `${privilegePrompt.name} 需要特权确认` : ""}
        centered
        maskClosable={false}
        onCancel={() => privilegePrompt?.onCancel()}
        footer={
          <Space>
            <Button onClick={() => privilegePrompt?.onCancel()}>取消</Button>
            <Button danger type="primary" onClick={() => privilegePrompt?.onConfirm()}>
              确认并安装
            </Button>
          </Space>
        }
      >
        {privilegePrompt && (
          <Flex vertical gap={12}>
            <Alert type="warning" showIcon message="这个应用需要以下特权，确认后才会继续安装" />
            <ul style={{ margin: 0, paddingInlineStart: 20 }}>
              {privilegePrompt.privileges.map((p) => (
                <li key={p}>
                  <code>{p}</code>：{privilegeInfo[p] ?? "平台不认识的特权"}
                </li>
              ))}
            </ul>
          </Flex>
        )}
      </Modal>
      <Modal
        open={Boolean(failurePrompt)}
        title={failurePrompt?.title}
        centered
        onCancel={() => setFailurePrompt(null)}
        footer={
          <Space>
            {failurePrompt?.buildId && (
              <Button
                onClick={() => {
                  setFailurePrompt(null);
                  onOpenBuild();
                }}
              >
                查看构建日志
              </Button>
            )}
            <Button type="primary" onClick={() => setFailurePrompt(null)}>
              知道了
            </Button>
          </Space>
        }
      >
        {failurePrompt && (
          <Flex vertical gap={12}>
            <Typography.Text type="danger">{failurePrompt.message}</Typography.Text>
            {failurePrompt.log && <LogCollapse log={failurePrompt.log} open />}
          </Flex>
        )}
      </Modal>
    </InstallContext.Provider>
  );
}

export function useInstallContext(): InstallContextValue | null {
  return useContext(InstallContext);
}

export function useInstallTasks(): InstallTask[] {
  return useContext(InstallContext)?.tasks ?? [];
}

export function useInstallTask(moduleId?: string): InstallTask | undefined {
  const ctx = useContext(InstallContext);
  return ctx?.taskByModuleId(moduleId);
}
