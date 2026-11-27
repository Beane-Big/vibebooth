import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
  type TouchEvent,
} from "react";
import { App as AntApp, Button, Card, Col, Empty, Row, Spin, Tag, Typography } from "antd";
import { api, hasPerm, userDisplayName, type App, type HomePrefs, type Me, type ThemeInfo } from "../api";
import type { BuiltinApp } from "../builtin";
import AppIcon from "../components/AppIcon";
import type { AppTab } from "../components/AppTabs";
import {
  AppContextMenu,
  HIDDEN_FOLDER_ID,
  HiddenFolderGlyph,
  HiddenFolderModal,
  UninstallAppModal,
  homeKeyForBuiltin,
  homeKeyForModule,
  orderHomeItems,
  reorderKeys,
  type ContextMenuState,
  type HomeItem,
} from "../components/HomeAppMenu";
import IosInstallOverlay, { installPhaseLabel } from "../components/IosInstallOverlay";
import { inPlace } from "../components/Layout";
import { useInstallTasks } from "../installContext";
import { useThemeMode, wallpaperURL } from "../theme";
import { ThemeBoundary, ThemeFallback, type ThemeApp, type ThemeDefinition } from "../themeHost";

const APP_DRAG_MIME = "application/x-vibebooth-app";
const LONG_PRESS_MS = 450;

type Props = {
  apps: App[];
  builtins: BuiltinApp[];
  onOpen: (tab: AppTab) => void;
  onOpenBuild?: () => void;
};

type ItemHandlers = {
  canCustomize: boolean;
  draggingKey: string | null;
  touchSortMode: boolean;
  onItemClick: (item: HomeItem, e: MouseEvent) => void;
  onDragStart: (item: HomeItem, e: DragEvent) => void;
  onDragOver: (item: HomeItem, e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: () => void;
  onContextMenu: (item: HomeItem, e: MouseEvent) => void;
  onTouchStart: (item: HomeItem, e: TouchEvent) => void;
  onTouchMove: (e: TouchEvent) => void;
  onTouchEnd: () => void;
};

type HomeRenderProps = {
  visibleItems: HomeItem[];
  installingNew: HomeItem[];
  hiddenCount: number;
  onOpenHiddenFolder: () => void;
  handlers: ItemHandlers;
};

// 首页列出能打开的应用，登录后支持按用户保存拖拽排序、隐藏到仿 iOS 隐藏文件夹，以及右键 / 长按菜单。
// 点卡片在门户里以标签页打开；按住 Ctrl / Cmd 或用中键点击时在浏览器新标签页打开，登录状态共享。
// 选用的主题包带了首页组件时由它来画；主题还没加载好时转圈，出错时提示并用经典皮肤。
export default function Home({
  user,
  theme,
  apps,
  builtins,
  onOpen,
  onOpenBuild,
}: Props & {
  user: Me | null;
  theme: { active: ThemeInfo | null; def: ThemeDefinition | null; error: string } | null;
}) {
  const { message } = AntApp.useApp();
  const { skin, dark, wallpaper } = useThemeMode();
  const installTasks = useInstallTasks();

  const canCustomize = Boolean(user);
  const canUninstall = Boolean(user && hasPerm(user, "modules"));

  const [prefs, setPrefs] = useState<HomePrefs>({ order: [], hidden: [] });
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  // 拖拽中的临时排序与状态；松手后写回后端。
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const draggingKeyRef = useRef<string | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragOrderRef = useRef<string[] | null>(null);
  const lastSwapRef = useRef<{ target: string; at: number }>({ target: "", at: 0 });
  const suppressClickUntilRef = useRef(0);

  // 右键 / 长按菜单、隐藏文件夹、卸载确认与移动端排序模式。
  const [menuState, setMenuState] = useState<ContextMenuState | null>(null);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [uninstallTarget, setUninstallTarget] = useState<HomeItem | null>(null);
  const [touchSortMode, setTouchSortMode] = useState(false);

  // 移动端长按与触控拖拽状态。
  const longPressTimerRef = useRef<number | null>(null);
  const touchOriginRef = useRef<{ x: number; y: number; item: HomeItem; hidden: boolean } | null>(null);
  const longPressedItemRef = useRef<HomeItem | null>(null);
  const touchDraggingRef = useRef<string | null>(null);

  useEffect(() => {
    if (!user) {
      setPrefs({ order: [], hidden: [] });
      setMenuState(null);
      setHiddenOpen(false);
      setTouchSortMode(false);
      return;
    }
    let active = true;
    api
      .homePrefs()
      .then((data) => {
        if (active) setPrefs(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [user?.id]);

  // 合并内置应用、模块应用与正在安装中的任务。
  const taskMap = useMemo(() => new Map(installTasks.map((t) => [t.moduleId, t])), [installTasks]);

  const allItems = useMemo<HomeItem[]>(() => {
    const builtinItems: HomeItem[] = builtins.map((app) => ({
      key: homeKeyForBuiltin(app.id),
      id: app.id,
      name: app.name,
      description: app.description,
      url: app.url,
      builtin: true,
      healthy: true,
      glyph: app.icon,
      tint: app.tint,
    }));
    const moduleItems: HomeItem[] = apps.map((app) => {
      const task = taskMap.get(app.id);
      return {
        key: homeKeyForModule(app.id),
        id: app.id,
        name: app.name,
        description: app.description,
        url: app.url,
        builtin: false,
        healthy: task ? true : app.healthy,
        icon: app.icon ?? task?.iconUrl,
        mask: app.glyph,
        color: app.color,
        installing: task,
      };
    });
    return [...builtinItems, ...moduleItems];
  }, [apps, builtins, taskMap]);

  const installingNew = useMemo<HomeItem[]>(
    () =>
      installTasks
        .filter((t) => !apps.some((a) => a.id === t.moduleId))
        .map((task) => ({
          key: homeKeyForModule(task.moduleId),
          id: task.moduleId,
          name: task.name,
          description: task.description,
          url: `/apps/${task.moduleId}/`,
          builtin: false,
          healthy: true,
          icon: task.iconUrl,
          installing: task,
        })),
    [apps, installTasks],
  );

  const effectiveOrder = canCustomize ? (dragOrder ?? prefs.order) : [];
  const orderedAll = useMemo(() => orderHomeItems(allItems, effectiveOrder), [allItems, effectiveOrder]);
  const orderedAllRef = useRef(orderedAll);
  orderedAllRef.current = orderedAll;

  const hiddenSet = useMemo(() => new Set(canCustomize ? prefs.hidden : []), [canCustomize, prefs.hidden]);
  const visibleItems = useMemo(() => orderedAll.filter((it) => !hiddenSet.has(it.key)), [orderedAll, hiddenSet]);
  const hiddenItems = useMemo(() => orderedAll.filter((it) => hiddenSet.has(it.key)), [orderedAll, hiddenSet]);

  // 隐藏应用被全部取消隐藏或卸载后，自动关闭隐藏文件夹弹窗。
  useEffect(() => {
    if (hiddenOpen && hiddenItems.length === 0) setHiddenOpen(false);
  }, [hiddenOpen, hiddenItems.length]);

  const savePrefs = useCallback(
    (patch: Partial<HomePrefs>) => {
      if (!canCustomize) return;
      const next: HomePrefs = {
        order: patch.order ?? prefsRef.current.order,
        hidden: patch.hidden ?? prefsRef.current.hidden,
      };
      setPrefs(next);
      api.saveHomePrefs(patch).catch((err) => {
        message.error(err instanceof Error ? err.message : "保存应用偏好失败");
        api
          .homePrefs()
          .then(setPrefs)
          .catch(() => {});
      });
    },
    [canCustomize, message],
  );

  const toggleHidden = useCallback(
    (item: HomeItem, hide: boolean) => {
      const cur = prefsRef.current.hidden;
      const next = hide
        ? cur.includes(item.key)
          ? cur
          : [...cur, item.key]
        : cur.filter((k) => k !== item.key);
      savePrefs({ hidden: next });
    },
    [savePrefs],
  );

  const handleUninstalled = useCallback(
    (key: string) => {
      if (!canCustomize) return;
      const cur = prefsRef.current;
      const nextHidden = cur.hidden.filter((k) => k !== key);
      const nextOrder = cur.order.filter((k) => k !== key);
      if (nextHidden.length !== cur.hidden.length || nextOrder.length !== cur.order.length) {
        savePrefs({ order: nextOrder, hidden: nextHidden });
      }
    },
    [canCustomize, savePrefs],
  );

  const swapOrderLive = useCallback((fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    const now = performance.now();
    if (lastSwapRef.current.target === toKey && now - lastSwapRef.current.at < 120) return;
    lastSwapRef.current = { target: toKey, at: now };

    const base = dragOrderRef.current ?? orderedAllRef.current.map((it) => it.key);
    const next = reorderKeys(base, fromKey, toKey);
    if (next !== base) {
      dragOrderRef.current = next;
      setDragOrder(next);
    }
  }, []);

  const finishDrag = useCallback(() => {
    const finalOrder = dragOrderRef.current;
    const prevOrder = prefsRef.current.order;
    const hadDrag = Boolean(draggingKeyRef.current || touchDraggingRef.current);

    draggingKeyRef.current = null;
    touchDraggingRef.current = null;
    dragOrderRef.current = null;
    setDraggingKey(null);
    setDragOrder(null);

    if (hadDrag) {
      suppressClickUntilRef.current = Date.now() + 260;
    }
    if (finalOrder && (finalOrder.length !== prevOrder.length || finalOrder.some((k, i) => k !== prevOrder[i]))) {
      savePrefs({ order: finalOrder });
    }
  }, [savePrefs]);

  // 移动端手指拖拽排序期间禁用页面滚动，并用 elementFromPoint 实时交换位置。
  useEffect(() => {
    if (!draggingKey || !touchDraggingRef.current) return;
    const onTouchMoveWin = (e: globalThis.TouchEvent) => {
      if (!touchDraggingRef.current || e.touches.length !== 1) return;
      e.preventDefault();
      const t = e.touches[0];
      const el = document.elementFromPoint(t.clientX, t.clientY)?.closest<HTMLElement>("[data-home-key]");
      const targetKey = el?.dataset.homeKey;
      if (targetKey && targetKey !== touchDraggingRef.current) {
        swapOrderLive(touchDraggingRef.current, targetKey);
      }
    };
    const onTouchEndWin = () => {
      if (touchDraggingRef.current) finishDrag();
    };
    window.addEventListener("touchmove", onTouchMoveWin, { passive: false });
    window.addEventListener("touchend", onTouchEndWin);
    window.addEventListener("touchcancel", onTouchEndWin);
    return () => {
      window.removeEventListener("touchmove", onTouchMoveWin);
      window.removeEventListener("touchend", onTouchEndWin);
      window.removeEventListener("touchcancel", onTouchEndWin);
    };
  }, [draggingKey, finishDrag, swapOrderLive]);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearLongPress(), [clearLongPress]);

  const openItem = useCallback(
    (item: HomeItem) => {
      const task = item.installing;
      if (task && task.phase !== "completing") {
        if (task.buildId && (task.phase === "queued" || task.phase === "building")) {
          onOpenBuild?.();
        }
        return;
      }
      onOpen({ url: item.url, title: item.name });
    },
    [onOpen, onOpenBuild],
  );

  const handleItemClick = useCallback(
    (item: HomeItem, e: MouseEvent) => {
      if (Date.now() < suppressClickUntilRef.current || touchSortMode) {
        e.preventDefault();
        return;
      }
      const task = item.installing;
      if (task && task.phase !== "completing") {
        e.preventDefault();
        if (task.buildId && (task.phase === "queued" || task.phase === "building")) {
          onOpenBuild?.();
        }
        return;
      }
      if (!inPlace(e)) return;
      e.preventDefault();
      onOpen({ url: item.url, title: item.name });
    },
    [onOpen, onOpenBuild, touchSortMode],
  );

  const handleDragStart = useCallback(
    (item: HomeItem, e: DragEvent) => {
      if (!canCustomize || (item.installing && item.installing.phase !== "completing")) {
        e.preventDefault();
        return;
      }
      setMenuState(null);
      e.dataTransfer.setData(APP_DRAG_MIME, item.key);
      e.dataTransfer.effectAllowed = "move";
      draggingKeyRef.current = item.key;
      setDraggingKey(item.key);
      const initial = orderedAllRef.current.map((it) => it.key);
      dragOrderRef.current = initial;
      setDragOrder(initial);
    },
    [canCustomize],
  );

  const handleDragOver = useCallback(
    (targetItem: HomeItem, e: DragEvent) => {
      const fromKey = draggingKeyRef.current;
      if (!fromKey || !e.dataTransfer.types.includes(APP_DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (fromKey !== targetItem.key) {
        swapOrderLive(fromKey, targetItem.key);
      }
    },
    [swapOrderLive],
  );

  const handleDrop = useCallback(
    (e: DragEvent) => {
      if (!draggingKeyRef.current) return;
      e.preventDefault();
      finishDrag();
    },
    [finishDrag],
  );

  const handleContextMenu = useCallback(
    (item: HomeItem, e: MouseEvent) => {
      if (!canCustomize || (item.installing && item.installing.phase !== "completing")) return;
      e.preventDefault();
      setMenuState({ item, x: e.clientX, y: e.clientY, hidden: false, fromTouch: false });
    },
    [canCustomize],
  );

  const startTouchHandlers = useCallback(
    (item: HomeItem, e: TouchEvent, hidden: boolean) => {
      if (!canCustomize || e.touches.length !== 1) return;
      if (item.installing && item.installing.phase !== "completing") return;
      const touch = e.touches[0];
      clearLongPress();
      longPressedItemRef.current = null;
      touchOriginRef.current = { x: touch.clientX, y: touch.clientY, item, hidden };

      // 移动端排序模式下，按下即刻进入拖拽。
      if (touchSortMode && !hidden) {
        touchDraggingRef.current = item.key;
        draggingKeyRef.current = item.key;
        setDraggingKey(item.key);
        const initial = orderedAllRef.current.map((it) => it.key);
        dragOrderRef.current = initial;
        setDragOrder(initial);
        return;
      }

      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        suppressClickUntilRef.current = Date.now() + 650;
        try {
          navigator.vibrate?.(15);
        } catch {}
        if (!hidden) longPressedItemRef.current = item;
        setMenuState({ item, x: touch.clientX, y: touch.clientY, hidden, fromTouch: true });
      }, LONG_PRESS_MS);
    },
    [canCustomize, clearLongPress, touchSortMode],
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (e.touches.length !== 1 || !touchOriginRef.current) return;
      const touch = e.touches[0];
      const dx = touch.clientX - touchOriginRef.current.x;
      const dy = touch.clientY - touchOriginRef.current.y;
      const dist = Math.hypot(dx, dy);

      if (longPressTimerRef.current !== null && dist > 10) {
        clearLongPress();
      }
      // 长按触发菜单后若手指继续拖动，自动收起菜单并无缝切换为手指拖拽排序。
      if (longPressedItemRef.current && !touchDraggingRef.current && dist > 14) {
        const item = longPressedItemRef.current;
        longPressedItemRef.current = null;
        setMenuState(null);
        touchDraggingRef.current = item.key;
        draggingKeyRef.current = item.key;
        setDraggingKey(item.key);
        const initial = orderedAllRef.current.map((it) => it.key);
        dragOrderRef.current = initial;
        setDragOrder(initial);
      }
    },
    [clearLongPress],
  );

  const handleTouchEnd = useCallback(() => {
    clearLongPress();
    touchOriginRef.current = null;
    longPressedItemRef.current = null;
    if (touchDraggingRef.current) {
      finishDrag();
    }
  }, [clearLongPress, finishDrag]);

  const handlers: ItemHandlers = {
    canCustomize,
    draggingKey,
    touchSortMode,
    onItemClick: handleItemClick,
    onDragStart: handleDragStart,
    onDragOver: handleDragOver,
    onDrop: handleDrop,
    onDragEnd: finishDrag,
    onContextMenu: handleContextMenu,
    onTouchStart: (item, e) => startTouchHandlers(item, e, false),
    onTouchMove: handleTouchMove,
    onTouchEnd: handleTouchEnd,
  };

  if (visibleItems.length === 0 && hiddenItems.length === 0 && installingNew.length === 0) {
    return <Empty description="还没有可用的应用。" />;
  }

  const renderProps: HomeRenderProps = {
    visibleItems,
    installingNew,
    hiddenCount: hiddenItems.length,
    onOpenHiddenFolder: () => setHiddenOpen(true),
    handlers,
  };

  let body: ReactNode;
  if (user && theme?.active) {
    const { name } = theme.active;
    if (theme.error) {
      body = <ThemeFallback name={name} error={theme.error} fallback={<ClassicHome {...renderProps} />} />;
    } else if (!theme.def) {
      body = <Spin style={{ display: "block", margin: "48px auto" }} />;
    } else if (theme.def.Home) {
      const ThemeHome = theme.def.Home;
      body = (
        <ThemeBoundary key={name} name={name} fallback={<ClassicHome {...renderProps} />}>
          <ThemeHome
            apps={themeApps(renderProps)}
            dark={dark}
            user={{ displayName: userDisplayName(user) }}
            wallpaper={wallpaperURL(wallpaper)}
          />
        </ThemeBoundary>
      );
    } else {
      body = skin === "tiles" ? <TilesHome {...renderProps} /> : <ClassicHome {...renderProps} />;
    }
  } else {
    body = skin === "tiles" ? <TilesHome {...renderProps} /> : <ClassicHome {...renderProps} />;
  }

  return (
    <div className={touchSortMode ? "vb-home-root vb-home-sorting" : "vb-home-root"}>
      {touchSortMode && (
        <div className="vb-sort-bar">
          <Typography.Text strong>拖动应用调整顺序</Typography.Text>
          <Button type="primary" size="small" shape="round" onClick={() => setTouchSortMode(false)}>
            完成
          </Button>
        </div>
      )}
      {body}
      {canCustomize && (
        <>
          <AppContextMenu
            state={menuState}
            canUninstall={canUninstall}
            onClose={() => setMenuState(null)}
            onToggleHidden={toggleHidden}
            onStartTouchSort={() => setTouchSortMode(true)}
            onUninstall={(item) => setUninstallTarget(item)}
          />
          <HiddenFolderModal
            open={hiddenOpen}
            items={hiddenItems}
            onClose={() => setHiddenOpen(false)}
            onOpenItem={openItem}
            onUnhide={(item) => toggleHidden(item, false)}
            onContextMenu={(item, x, y, fromTouch) =>
              setMenuState({ item, x, y, hidden: true, fromTouch })
            }
            onTouchStart={(item, e) => startTouchHandlers(item, e, true)}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          />
          <UninstallAppModal
            item={uninstallTarget}
            onClose={() => setUninstallTarget(null)}
            onUninstalled={handleUninstalled}
          />
        </>
      )}
    </div>
  );
}

function itemHref(item: HomeItem): string {
  const task = item.installing;
  if (task && task.phase !== "completing") {
    return task.buildId ? "/applications/build" : "#installing";
  }
  return item.url;
}

// themeApps 把可见应用、安装中的应用和已隐藏文件夹统一成交给主题的格式。
function themeApps({
  visibleItems,
  installingNew,
  hiddenCount,
  onOpenHiddenFolder,
  handlers,
}: HomeRenderProps): ThemeApp[] {
  const toThemeApp = (item: HomeItem, sortable: boolean): ThemeApp => {
    const task = item.installing;
    const active = Boolean(task && task.phase !== "completing");
    const allowInteract = sortable && handlers.canCustomize && !active;
    return {
      id: item.id,
      name: active && task ? installPhaseLabel(task) : item.name,
      description: item.description,
      url: item.url,
      icon: item.icon,
      mask: item.mask,
      color: item.color,
      glyph: item.glyph,
      tint: item.tint,
      healthy: active ? true : item.healthy,
      builtin: item.builtin,
      link: {
        href: itemHref(item),
        onClick: (e) => handlers.onItemClick(item, e),
        ...(allowInteract
          ? {
              draggable: true,
              "data-home-key": item.key,
              "data-dragging": handlers.draggingKey === item.key ? "true" : undefined,
              onDragStart: (e) => handlers.onDragStart(item, e),
              onDragOver: (e) => handlers.onDragOver(item, e),
              onDrop: (e) => handlers.onDrop(e),
              onDragEnd: () => handlers.onDragEnd(),
              onContextMenu: (e) => handlers.onContextMenu(item, e),
              onTouchStart: (e) => handlers.onTouchStart(item, e),
              onTouchMove: (e) => handlers.onTouchMove(e),
              onTouchEnd: () => handlers.onTouchEnd(),
              onTouchCancel: () => handlers.onTouchEnd(),
            }
          : {}),
      },
    };
  };

  const list: ThemeApp[] = [
    ...visibleItems.map((it) => toThemeApp(it, true)),
    ...installingNew.map((it) => toThemeApp(it, false)),
  ];

  if (hiddenCount > 0) {
    list.push({
      id: HIDDEN_FOLDER_ID,
      name: "已隐藏",
      description: `${hiddenCount} 个隐藏应用`,
      url: "#hidden",
      glyph: <HiddenFolderGlyph count={hiddenCount} />,
      tint: ["#8c95a6", "#5a6375"],
      healthy: true,
      builtin: true,
      link: {
        href: "#hidden",
        onClick: (e) => {
          e.preventDefault();
          onOpenHiddenFolder();
        },
      },
    });
  }
  return list;
}

// 彩色方块皮肤。
function TilesHome({
  visibleItems,
  installingNew,
  hiddenCount,
  onOpenHiddenFolder,
  handlers,
}: HomeRenderProps) {
  return (
    <div className="app-tiles">
      {visibleItems.map((item) => (
        <AppTile key={item.key} item={item} sortable handlers={handlers} />
      ))}
      {installingNew.map((item) => (
        <AppTile key={`installing:${item.key}`} item={item} isNew handlers={handlers} />
      ))}
      {hiddenCount > 0 && <HiddenFolderTile count={hiddenCount} onOpen={onOpenHiddenFolder} />}
    </div>
  );
}

// 经典皮肤：带名称和说明的卡片。
function ClassicHome({
  visibleItems,
  installingNew,
  hiddenCount,
  onOpenHiddenFolder,
  handlers,
}: HomeRenderProps) {
  return (
    <Row gutter={[16, 16]}>
      {visibleItems.map((item) => (
        <AppCard key={item.key} item={item} sortable handlers={handlers} />
      ))}
      {installingNew.map((item) => (
        <AppCard key={`installing:${item.key}`} item={item} isNew handlers={handlers} />
      ))}
      {hiddenCount > 0 && <HiddenFolderCard count={hiddenCount} onOpen={onOpenHiddenFolder} />}
    </Row>
  );
}

// AppCard 是一张应用卡片，点击在门户里以标签页打开，卡片上的名称就是标签标题。
function AppCard({
  item,
  sortable = false,
  isNew = false,
  handlers,
}: {
  item: HomeItem;
  sortable?: boolean;
  isNew?: boolean;
  handlers: ItemHandlers;
}) {
  const installing = item.installing;
  const active = Boolean(installing && installing.phase !== "completing");
  const allowInteract = sortable && handlers.canCustomize && !active;
  const isDragging = handlers.draggingKey === item.key;

  return (
    <Col
      xs={24}
      sm={12}
      lg={8}
      xxl={6}
      className={`${isNew ? "vb-ios-appear " : ""}${isDragging ? "vb-app-dragging" : ""}`.trim() || undefined}
      data-home-key={allowInteract ? item.key : undefined}
    >
      <a
        href={itemHref(item)}
        aria-busy={active || undefined}
        draggable={allowInteract}
        onClick={(e) => handlers.onItemClick(item, e)}
        onDragStart={allowInteract ? (e) => handlers.onDragStart(item, e) : undefined}
        onDragOver={allowInteract ? (e) => handlers.onDragOver(item, e) : undefined}
        onDrop={allowInteract ? (e) => handlers.onDrop(e) : undefined}
        onDragEnd={allowInteract ? () => handlers.onDragEnd() : undefined}
        onContextMenu={allowInteract ? (e) => handlers.onContextMenu(item, e) : undefined}
        onTouchStart={allowInteract ? (e) => handlers.onTouchStart(item, e) : undefined}
        onTouchMove={allowInteract ? (e) => handlers.onTouchMove(e) : undefined}
        onTouchEnd={allowInteract ? () => handlers.onTouchEnd() : undefined}
        onTouchCancel={allowInteract ? () => handlers.onTouchEnd() : undefined}
      >
        <Card hoverable={!active} size="small" styles={{ body: { padding: 16 } }}>
          <div className="app-card">
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
            <div className="app-text">
              <Typography.Text strong ellipsis>
                {item.name}
                {active && installing && (
                  <Tag color="processing" style={{ marginInlineStart: 8 }}>
                    {installPhaseLabel(installing)}
                  </Tag>
                )}
                {!active && !item.healthy && (
                  <Tag color="error" style={{ marginInlineStart: 8 }}>
                    不可用
                  </Tag>
                )}
              </Typography.Text>
              <Typography.Text type="secondary" ellipsis>
                {item.description || " "}
              </Typography.Text>
            </div>
          </div>
        </Card>
      </a>
    </Col>
  );
}

function HiddenFolderCard({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <Col xs={24} sm={12} lg={8} xxl={6}>
      <a
        href="#hidden"
        onClick={(e) => {
          e.preventDefault();
          onOpen();
        }}
      >
        <Card hoverable size="small" styles={{ body: { padding: 16 } }}>
          <div className="app-card">
            <span className="app-icon vb-hidden-folder-icon">
              <HiddenFolderGlyph count={count} />
            </span>
            <div className="app-text">
              <Typography.Text strong ellipsis>
                已隐藏
              </Typography.Text>
              <Typography.Text type="secondary" ellipsis>
                {count} 个应用
              </Typography.Text>
            </div>
          </div>
        </Card>
      </a>
    </Col>
  );
}

// AppTile 是彩色方块皮肤里的一个应用：图标铺满圆角方块，名称在底部的半透明胶囊里；说明不显示，鼠标停在上面时提示。
function AppTile({
  item,
  sortable = false,
  isNew = false,
  handlers,
}: {
  item: HomeItem;
  sortable?: boolean;
  isNew?: boolean;
  handlers: ItemHandlers;
}) {
  const installing = item.installing;
  const active = Boolean(installing && installing.phase !== "completing");
  const completing = installing?.phase === "completing";
  const allowInteract = sortable && handlers.canCustomize && !active;
  const isDragging = handlers.draggingKey === item.key;

  const image = item.icon;
  const art = image && (
    <>
      <img className="app-tile-fill" src={image} alt="" draggable={false} />
      <img className="app-tile-img" src={image} alt="" draggable={false} />
    </>
  );
  const [from, to] = item.tint ?? ["oklch(from var(--accent) calc(l + 0.15) c calc(h - 40))", "var(--accent)"];
  const label =
    active && installing
      ? installPhaseLabel(installing)
      : !item.healthy
        ? `${item.name} · 不可用`
        : item.name;

  return (
    <a
      href={itemHref(item)}
      className={`app-tile${!item.healthy && !active ? " unhealthy" : ""}${active ? " is-installing" : ""}${isNew ? " vb-ios-appear" : ""}${isDragging ? " vb-app-dragging" : ""}`}
      title={item.description || undefined}
      aria-busy={active || undefined}
      draggable={allowInteract}
      data-home-key={allowInteract ? item.key : undefined}
      onClick={(e) => handlers.onItemClick(item, e)}
      onDragStart={allowInteract ? (e) => handlers.onDragStart(item, e) : undefined}
      onDragOver={allowInteract ? (e) => handlers.onDragOver(item, e) : undefined}
      onDrop={allowInteract ? (e) => handlers.onDrop(e) : undefined}
      onDragEnd={allowInteract ? () => handlers.onDragEnd() : undefined}
      onContextMenu={allowInteract ? (e) => handlers.onContextMenu(item, e) : undefined}
      onTouchStart={allowInteract ? (e) => handlers.onTouchStart(item, e) : undefined}
      onTouchMove={allowInteract ? (e) => handlers.onTouchMove(e) : undefined}
      onTouchEnd={allowInteract ? () => handlers.onTouchEnd() : undefined}
      onTouchCancel={allowInteract ? () => handlers.onTouchEnd() : undefined}
    >
      <span className={`app-tile-square${completing ? " vb-ios-pop" : ""}`}>
        {image ? (
          <img className="app-tile-shadow" src={image} alt="" draggable={false} />
        ) : (
          <span className="app-tile-shadow" style={{ background: to }} />
        )}
        <span
          className="app-tile-face"
          style={image ? undefined : { background: `linear-gradient(150deg, ${from}, ${to} 75%)` }}
        >
          {art ? (
            <>
              <span className="app-tile-art">{art}</span>
              <span className="app-tile-art app-tile-tint">{art}</span>
            </>
          ) : (
            <span className="app-tile-glyph">{item.glyph ?? item.name.slice(0, 1)}</span>
          )}
          {installing && <IosInstallOverlay task={installing} />}
          <span className="app-tile-label">{label}</span>
        </span>
      </span>
    </a>
  );
}

function HiddenFolderTile({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <a
      href="#hidden"
      className="app-tile vb-hidden-tile"
      title={`已隐藏（${count} 个应用）`}
      onClick={(e) => {
        e.preventDefault();
        onOpen();
      }}
    >
      <span className="app-tile-square">
        <span className="app-tile-shadow vb-hidden-tile-shadow" />
        <span className="app-tile-face vb-hidden-tile-face">
          <HiddenFolderGlyph count={count} />
          <span className="app-tile-label">已隐藏</span>
        </span>
      </span>
    </a>
  );
}
