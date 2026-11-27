import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Alert, App as AntApp, Button, Checkbox, Flex, Modal, Space, Typography } from "antd";
import { DeleteOutlined, DragOutlined, EyeInvisibleOutlined, EyeOutlined } from "@ant-design/icons";
import { api, ApiError, notifyAppsChanged, type InstalledModule } from "../api";
import type { InstallTask } from "../installContext";
import AppIcon from "./AppIcon";
import { LogCollapse } from "./PackageUpload";

export const HIDDEN_FOLDER_ID = "__vb_hidden_folder__";

export type HomeItem = {
  // 唯一持久键：内置应用为 "builtin:<id>"，模块应用为 "<id>"。
  key: string;
  id: string;
  name: string;
  description: string;
  url: string;
  builtin: boolean;
  healthy: boolean;
  icon?: string;
  mask?: string;
  color?: string;
  glyph?: ReactNode;
  tint?: [string, string];
  installing?: InstallTask;
};

export const homeKeyForBuiltin = (id: string) => `builtin:${id}`;
export const homeKeyForModule = (id: string) => id;

export function orderHomeItems(items: HomeItem[], savedOrder: string[]): HomeItem[] {
  if (savedOrder.length === 0) return items;
  const byKey = new Map(items.map((it) => [it.key, it]));
  const ordered: HomeItem[] = [];
  const used = new Set<string>();
  for (const key of savedOrder) {
    const it = byKey.get(key);
    if (it && !used.has(key)) {
      ordered.push(it);
      used.add(key);
    }
  }
  for (const it of items) {
    if (!used.has(it.key)) ordered.push(it);
  }
  return ordered;
}

export function reorderKeys(keys: string[], fromKey: string, toKey: string): string[] {
  const from = keys.indexOf(fromKey);
  const to = keys.indexOf(toKey);
  if (from < 0 || to < 0 || from === to) return keys;
  const next = keys.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export type ContextMenuState = {
  item: HomeItem;
  x: number;
  y: number;
  hidden: boolean;
  fromTouch: boolean;
};

// 仿 iOS 隐藏文件夹图标：2×2 磨砂小方块 + 中央隐藏图标。
export function HiddenFolderGlyph({ count }: { count: number }) {
  const slots = Math.min(4, Math.max(1, count));
  return (
    <span className="vb-hidden-glyph" aria-hidden="true">
      <span className="vb-hidden-glyph-grid">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={i < slots ? "vb-hidden-slot active" : "vb-hidden-slot"} />
        ))}
      </span>
      <EyeInvisibleOutlined className="vb-hidden-glyph-eye" />
    </span>
  );
}

// 右键 / 移动端长按浮层菜单：支持隐藏/取消隐藏、移动端进入排序、以及有应用管理权限时的卸载。
export function AppContextMenu({
  state,
  canUninstall,
  onClose,
  onToggleHidden,
  onStartTouchSort,
  onUninstall,
}: {
  state: ContextMenuState | null;
  canUninstall: boolean;
  onClose: () => void;
  onToggleHidden: (item: HomeItem, hide: boolean) => void;
  onStartTouchSort?: () => void;
  onUninstall: (item: HomeItem) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!state) {
      setPos(null);
      return;
    }
    const el = menuRef.current;
    const w = el?.offsetWidth ?? 176;
    const h = el?.offsetHeight ?? 112;
    const pad = 12;
    const left = Math.max(pad, Math.min(state.x, window.innerWidth - w - pad));
    const top = Math.max(pad, Math.min(state.y, window.innerHeight - h - pad));
    setPos({ left, top });
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [state, onClose]);

  if (!state) return null;

  const showUninstall = canUninstall && !state.item.builtin;
  const showTouchSort = state.fromTouch && !state.hidden && Boolean(onStartTouchSort);

  return (
    <div
      ref={menuRef}
      role="menu"
      className="vb-context-menu"
      style={{
        left: pos?.left ?? state.x,
        top: pos?.top ?? state.y,
        visibility: pos ? "visible" : "hidden",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="vb-context-menu-header">{state.item.name}</div>
      <button
        type="button"
        role="menuitem"
        className="vb-context-menu-item"
        onClick={() => {
          onToggleHidden(state.item, !state.hidden);
          onClose();
        }}
      >
        {state.hidden ? <EyeOutlined /> : <EyeInvisibleOutlined />}
        <span>{state.hidden ? "取消隐藏" : "隐藏"}</span>
      </button>
      {showTouchSort && (
        <button
          type="button"
          role="menuitem"
          className="vb-context-menu-item"
          onClick={() => {
            onClose();
            onStartTouchSort?.();
          }}
        >
          <DragOutlined />
          <span>调整排序</span>
        </button>
      )}
      {showUninstall && (
        <>
          <div className="vb-context-menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="vb-context-menu-item is-danger"
            onClick={() => {
              onClose();
              onUninstall(state.item);
            }}
          >
            <DeleteOutlined />
            <span>卸载</span>
          </button>
        </>
      )}
    </div>
  );
}

// 仿 iOS 已隐藏应用文件夹弹窗：可点击打开、一键取消隐藏，或右键/长按操作。
export function HiddenFolderModal({
  open,
  items,
  onClose,
  onOpenItem,
  onUnhide,
  onContextMenu,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
}: {
  open: boolean;
  items: HomeItem[];
  onClose: () => void;
  onOpenItem: (item: HomeItem) => void;
  onUnhide: (item: HomeItem) => void;
  onContextMenu: (item: HomeItem, x: number, y: number, fromTouch: boolean) => void;
  onTouchStart: (item: HomeItem, e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
}) {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      centered
      width={520}
      className="vb-hidden-modal"
      title={
        <Space size={8}>
          <EyeInvisibleOutlined />
          <span>已隐藏</span>
        </Space>
      }
    >
      {items.length === 0 ? (
        <Typography.Text type="secondary">暂无隐藏的应用</Typography.Text>
      ) : (
        <div className="vb-hidden-grid">
          {items.map((item) => (
            <div
              key={item.key}
              className="vb-hidden-item"
              onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu(item, e.clientX, e.clientY, false);
              }}
              onTouchStart={(e) => onTouchStart(item, e)}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
              onTouchCancel={onTouchEnd}
            >
              <button
                type="button"
                className="vb-hidden-item-open"
                onClick={() => {
                  onClose();
                  onOpenItem(item);
                }}
              >
                <AppIcon
                  app={{
                    id: item.id,
                    name: item.name,
                    icon: item.icon,
                    mask: item.mask,
                    color: item.color,
                    glyph: item.glyph,
                    tint: item.tint,
                  }}
                />
                <span className="vb-hidden-item-name">{item.name}</span>
              </button>
              <button
                type="button"
                className="vb-hidden-item-restore"
                title="取消隐藏"
                aria-label={`取消隐藏 ${item.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onUnhide(item);
                }}
              >
                <EyeOutlined />
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// 从首页右键/长按触发的模块卸载确认弹窗，与“应用管理”保持一致的依赖检查和数据保留选项。
export function UninstallAppModal({
  item,
  onClose,
  onUninstalled,
}: {
  item: HomeItem | null;
  onClose: () => void;
  onUninstalled: (key: string) => void;
}) {
  const { message } = AntApp.useApp();
  const [purge, setPurge] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [modInfo, setModInfo] = useState<InstalledModule | null>(null);
  const [error, setError] = useState<{ text: string; log: string } | null>(null);

  useEffect(() => {
    if (!item) return;
    let active = true;
    setPurge(false);
    setSubmitting(false);
    setError(null);
    setModInfo(null);
    api
      .modules()
      .then((list) => {
        if (active) setModInfo(list.find((m) => m.id === item.id) ?? null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [item]);

  const blockedBy = modInfo?.requiredBy ?? [];

  async function confirm() {
    if (!item || blockedBy.length > 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.uninstallModule(item.id, purge);
      void notifyAppsChanged(item.id);
      onUninstalled(item.key);
      message.success(purge ? `${item.name} 已卸载，数据已删除` : `${item.name} 已卸载，数据保留`);
      onClose();
    } catch (err) {
      setError({
        text: err instanceof Error ? err.message : "卸载失败",
        log: err instanceof ApiError ? err.log : "",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={Boolean(item)}
      title={item ? `卸载「${item.name}」` : ""}
      centered
      maskClosable={!submitting}
      closable={!submitting}
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button danger type="primary" loading={submitting} disabled={blockedBy.length > 0} onClick={confirm}>
            确认卸载
          </Button>
        </Space>
      }
    >
      {item && (
        <Flex vertical gap={12} style={{ paddingTop: 4 }}>
          {blockedBy.length > 0 ? (
            <Alert type="warning" showIcon message={`请先卸载依赖此应用的其他应用：${blockedBy.join("、")}`} />
          ) : (
            <Checkbox checked={purge} disabled={submitting} onChange={(e) => setPurge(e.target.checked)}>
              同时删除数据（无法恢复）
            </Checkbox>
          )}
          {error && (
            <Alert
              type="error"
              showIcon
              message={error.text}
              description={error.log && <LogCollapse log={error.log} open />}
            />
          )}
        </Flex>
      )}
    </Modal>
  );
}
