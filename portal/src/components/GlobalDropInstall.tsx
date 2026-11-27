import { useEffect, useRef, useState } from "react";
import { Alert, App as AntApp, Button, Checkbox, Flex, Modal, Select, Space, Tag, Typography } from "antd";
import { InboxOutlined } from "@ant-design/icons";
import {
  api,
  APPS_CHANGED_EVENT,
  appScopeOptions,
  defaultAppScope,
  hasPerm,
  isAdmin,
  maxPackageMB,
  type App as AppInfo,
  type AppAccess,
  type AppScope,
  type InstalledModule,
  type Me,
} from "../api";
import { maxSourceMB } from "../pages/builder/api";
import { useInstallContext } from "../installContext";
import IosInstallOverlay, { installPhaseLabel } from "./IosInstallOverlay";
import { inspectDroppedZip, type InspectedZip } from "../zipInspect";

function isFileDrag(e: DragEvent): boolean {
  return Boolean(e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files"));
}

function isLocalDropTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".ant-upload-drag"));
}

function formatSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function revokeIfBlob(url?: string) {
  if (url && url.startsWith("blob:")) {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }
}

export default function GlobalDropInstall({
  user,
  apps,
  onHomeTab,
  onGoHome,
  onOpenBuild,
}: {
  user: Me;
  apps: AppInfo[] | null;
  onHomeTab: boolean;
  onGoHome: () => void;
  onOpenBuild: () => void;
}) {
  const { message } = AntApp.useApp();
  const ctx = useInstallContext();
  const canInstall = hasPerm(user, "modules");
  const admin = isAdmin(user);

  const [dragging, setDragging] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [pending, setPending] = useState<InspectedZip[]>([]);
  const [installedModules, setInstalledModules] = useState<InstalledModule[] | null>(null);
  const [accessMap, setAccessMap] = useState<Record<string, AppAccess>>({});
  const [installAfter, setInstallAfter] = useState(false);
  const [scope, setScope] = useState<AppScope>(defaultAppScope);
  const scopeTouchedRef = useRef(false);

  const current = pending[0] ?? null;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const accessMapRef = useRef(accessMap);
  accessMapRef.current = accessMap;

  // 组件卸载时释放未提交的图标 blob URL。
  useEffect(() => {
    return () => {
      for (const item of pendingRef.current) revokeIfBlob(item.iconUrl);
    };
  }, []);

  // 管理员预先缓存平台当前权限范围，并在应用变更后同步，避免弹窗打开时闪烁。
  useEffect(() => {
    if (!admin) return;
    const syncAccess = () => {
      api
        .appAccess()
        .then(setAccessMap)
        .catch(() => {});
    };
    syncAccess();
    window.addEventListener(APPS_CHANGED_EVENT, syncAccess);
    return () => window.removeEventListener(APPS_CHANGED_EVENT, syncAccess);
  }, [admin]);

  // 每次切换待确认的压缩包时重置勾选和权限范围：新装默认按权限访问，更新已有应用默认沿用平台当前权限范围。
  useEffect(() => {
    if (!current) return;
    let active = true;
    const modId = current.manifest?.id ?? "";
    scopeTouchedRef.current = false;
    setInstallAfter(false);
    setScope((modId && accessMapRef.current[modId]?.scope) || defaultAppScope);
    api
      .modules()
      .then((list) => active && setInstalledModules(list))
      .catch(() => {});
    if (admin) {
      api
        .appAccess()
        .then((next) => {
          if (!active) return;
          setAccessMap(next);
          if (!scopeTouchedRef.current) {
            setScope((modId && next[modId]?.scope) || defaultAppScope);
          }
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [admin, current]);

  useEffect(() => {
    if (!canInstall) return;

    const handleDragEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      if (isLocalDropTarget(e.target)) {
        setDragging(false);
        return;
      }
      e.preventDefault();
      setDragging(true);
    };

    const handleDragOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      if (isLocalDropTarget(e.target)) {
        setDragging(false);
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setDragging(true);
    };

    const handleDragLeave = (e: DragEvent) => {
      if (
        e.relatedTarget === null ||
        e.clientX <= 0 ||
        e.clientY <= 0 ||
        e.clientX >= window.innerWidth ||
        e.clientY >= window.innerHeight
      ) {
        setDragging(false);
      }
    };

    const handleReset = () => setDragging(false);

    const handleDrop = async (e: DragEvent) => {
      setDragging(false);
      if (!isFileDrag(e)) return;
      if (isLocalDropTarget(e.target)) return;
      e.preventDefault();

      const dropped = Array.from(e.dataTransfer?.files ?? []);
      if (dropped.length === 0) return;

      const zips = dropped.filter((f) => f.name.toLowerCase().endsWith(".zip"));
      if (zips.length === 0) {
        message.warning("请拖入 .zip 格式的应用安装包或源码包");
        return;
      }

      setInspecting(true);
      const valid: InspectedZip[] = [];
      try {
        for (const file of zips) {
          const result = await inspectDroppedZip(file);
          if (result.kind === "source" && !admin) {
            revokeIfBlob(result.iconUrl);
            message.info("当前账号不支持构建源码包，请使用管理员账号构建");
          } else if (result.kind === "package" || result.kind === "source") {
            valid.push(result);
          } else if (result.kind === "theme") {
            message.info(result.error ?? "检测到门户主题包，请前往「外观」页面上传安装");
          } else {
            message.error(result.error ?? `${file.name} 不是有效的应用包或源码包`);
          }
        }
      } finally {
        setInspecting(false);
      }

      if (valid.length > 0) {
        setPending((prev) => [...prev, ...valid]);
      }
    };

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);
    window.addEventListener("dragend", handleReset);
    window.addEventListener("blur", handleReset);
    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
      window.removeEventListener("dragend", handleReset);
      window.removeEventListener("blur", handleReset);
    };
  }, [admin, canInstall, message]);

  if (!canInstall || !ctx) return null;

  const manifest = current?.manifest;
  const moduleId = manifest?.id || current?.file.name.replace(/\.zip$/i, "") || "";
  const displayName = manifest?.name || moduleId;
  const existing =
    installedModules?.find((m) => m.id === moduleId) ??
    apps?.find((a) => a.id === moduleId) ??
    null;
  const isUpgrade = Boolean(existing);
  const busySame = Boolean(current && ctx.isModuleBusy(moduleId));
  const tooLarge = Boolean(
    current &&
      ((current.kind === "package" && current.file.size > maxPackageMB * 1024 * 1024) ||
        (current.kind === "source" && current.file.size > maxSourceMB * 1024 * 1024)),
  );
  const sourceNoAdmin = Boolean(current && current.kind === "source" && !admin);
  const confirmDisabled = busySame || tooLarge || sourceNoAdmin;

  function dismissCurrent() {
    if (current) revokeIfBlob(current.iconUrl);
    setPending((prev) => prev.slice(1));
  }

  function confirmCurrent() {
    if (!current || !ctx || confirmDisabled) return;
    const item = current;
    setPending((prev) => prev.slice(1));
    if (item.kind === "package") {
      ctx.startPackageInstall({
        file: item.file,
        inspected: item,
        scope: admin ? scope : undefined,
        isUpgrade,
      });
      onGoHome();
    } else if (item.kind === "source") {
      void ctx.startSourceBuild({
        file: item.file,
        inspected: item,
        installAfter,
        scope: installAfter && admin ? scope : undefined,
        isUpgrade,
      });
      if (installAfter) onGoHome();
    }
  }

  return (
    <>
      {(dragging || inspecting) && (
        <div className="vb-drop-overlay" aria-hidden="true">
          <div className="vb-drop-card">
            <InboxOutlined className="vb-drop-icon" />
            <div className="vb-drop-title">
              {inspecting
                ? "正在识别压缩包…"
                : admin
                  ? "松开即可安装应用包或构建源码包"
                  : "松开即可安装应用包"}
            </div>
          </div>
        </div>
      )}

      <Modal
        open={Boolean(current)}
        title={
          current?.kind === "source"
            ? "构建应用"
            : isUpgrade
              ? "更新应用"
              : "安装应用"
        }
        centered
        destroyOnHidden
        onCancel={dismissCurrent}
        footer={
          <Space>
            <Button onClick={dismissCurrent}>取消</Button>
            <Button type="primary" disabled={confirmDisabled} onClick={confirmCurrent}>
              {current?.kind === "source"
                ? installAfter
                  ? "构建并安装"
                  : "开始构建"
                : "继续安装"}
            </Button>
          </Space>
        }
      >
        {current && (
          <Flex vertical gap={16} style={{ paddingTop: 4 }}>
            <div className="vb-drop-preview">
              {current.iconUrl ? (
                <img className="app-icon" src={current.iconUrl} alt="" />
              ) : (
                <span className="app-icon app-icon-plain">{displayName.slice(0, 1)}</span>
              )}
              <Flex vertical gap={4} style={{ minWidth: 0, flex: 1 }}>
                <Space size={6} wrap>
                  <Typography.Text strong>{displayName}</Typography.Text>
                  {manifest?.version && (
                    <Tag style={{ marginInlineEnd: 0 }}>
                      {existing && existing.version !== manifest.version
                        ? `${existing.version} → ${manifest.version}`
                        : manifest.version}
                    </Tag>
                  )}
                  <Tag color={current.kind === "source" ? "blue" : "green"} style={{ marginInlineEnd: 0 }}>
                    {current.kind === "source" ? "源码包" : "安装包"}
                  </Tag>
                </Space>
                <Typography.Text type="secondary" ellipsis>
                  {moduleId} · {formatSize(current.file.size)}
                </Typography.Text>
              </Flex>
            </div>

            {tooLarge && (
              <Alert
                type="error"
                showIcon
                message={
                  current.kind === "source"
                    ? `源码包不能超过 ${maxSourceMB} MB`
                    : `模块包不能超过 ${maxPackageMB} MB`
                }
              />
            )}
            {sourceNoAdmin && <Alert type="warning" showIcon message="只有管理员可以构建源码包" />}
            {busySame && <Alert type="warning" showIcon message="该应用正在构建或安装中" />}

            {current.kind === "package" && !tooLarge && !busySame && (
              <>
                <Typography.Text>{isUpgrade ? "是否继续更新并安装此应用？" : "是否继续安装此应用？"}</Typography.Text>
                {admin && (
                  <Flex align="center" justify="space-between" gap={12}>
                    <Typography.Text>权限范围</Typography.Text>
                    <Select
                      aria-label="权限范围"
                      value={scope}
                      onChange={(next) => {
                        scopeTouchedRef.current = true;
                        setScope(next);
                      }}
                      options={appScopeOptions}
                      style={{ minWidth: 160 }}
                    />
                  </Flex>
                )}
              </>
            )}

            {current.kind === "source" && admin && !tooLarge && !busySame && (
              <>
                <Typography.Text>是否开始构建此源码包？</Typography.Text>
                <Flex vertical gap={12}>
                  <Checkbox checked={installAfter} onChange={(e) => setInstallAfter(e.target.checked)}>
                    构建并安装
                  </Checkbox>
                  {installAfter && (
                    <Flex align="center" justify="space-between" gap={12}>
                      <Typography.Text>权限范围</Typography.Text>
                      <Select
                        aria-label="权限范围"
                        value={scope}
                        onChange={(next) => {
                          scopeTouchedRef.current = true;
                          setScope(next);
                        }}
                        options={appScopeOptions}
                        style={{ minWidth: 160 }}
                      />
                    </Flex>
                  )}
                </Flex>
              </>
            )}
          </Flex>
        )}
      </Modal>

      {!onHomeTab && ctx.tasks.length > 0 && (
        <div className="vb-install-dock" role="status" aria-live="polite">
          {ctx.tasks.map((task) => {
            const dockIcon = task.iconUrl ?? apps?.find((a) => a.id === task.moduleId)?.icon;
            return (
              <button
                key={task.key}
                type="button"
                className="vb-install-dock-item"
                onClick={() =>
                  task.buildId && (task.phase === "queued" || task.phase === "building")
                    ? onOpenBuild()
                    : onGoHome()
                }
              >
                <span className={`vb-ios-icon vb-install-dock-icon${task.phase === "completing" ? " vb-ios-pop" : ""}`}>
                  {dockIcon ? (
                    <img src={dockIcon} alt="" />
                  ) : (
                    <span className="vb-install-dock-fallback">{task.name.slice(0, 1)}</span>
                  )}
                  <IosInstallOverlay task={task} />
                </span>
                <span className="vb-install-dock-text">
                  <span className="vb-install-dock-name">{task.name}</span>
                  <span className="vb-install-dock-phase">{installPhaseLabel(task)}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
