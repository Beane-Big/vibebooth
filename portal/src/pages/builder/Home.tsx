import { Alert, App as AntApp, Button, Card, Checkbox, List, Select, Space, Tag, Typography, Upload } from "antd";
import { ClearOutlined, CopyOutlined, DownloadOutlined, InboxOutlined, LoadingOutlined, SettingOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  api as portalApi,
  APPS_CHANGED_EVENT,
  appScopeLabel,
  appScopeOptions,
  defaultAppScope,
  finalizeModuleInstall,
  isAppScope,
  type AppAccess,
  type AppScope,
} from "../../api";
import {
  api,
  ApiError,
  BUILDS_CHANGED_EVENT,
  compareVersions,
  isRunning,
  packageUrl,
  privilegeInfo,
  skillUrl,
  statusText,
  type Build,
  type BuildArg,
  type BuildDetail,
  type Installed,
  type Me,
  type Rules,
} from "./api";
import { useInstallContext } from "../../installContext";
import { inspectDroppedZip } from "../../zipInspect";


// 展开在某条记录下方的内容：构建日志或安装日志，同一时间只展开一个。
type Expanded = { id: number; panel: "build" | "install" };

// 构建器自己的模块 id：装它会替换正在用的这个构建器。
const SELF_ID = "builder";

// 刚在本页装完的结果；安装日志保存在后端，保存失败时日志也留在这里，免得看不到。
type InstallNotice = { id: number; ok: boolean; message: string; log?: string };

// 列表中等待上传的源码包：可单独勾选“构建并安装”及安装后的权限范围（新装默认按权限访问，更新已有应用沿用平台现有配置）。
type SourceItem = { file: File; moduleId?: string; installAfter: boolean; scope: AppScope; scopeTouched?: boolean };

// 勾选“构建并安装”上传的记录，构建成功后在本页自动安装并写入对应权限范围。存在 sessionStorage 里，刷新本页不丢，关掉页签就不再自动装。
type AutoInstall = { id: number; scope: AppScope };

const AUTO_KEY = "builder:auto-install";

function loadAuto(): AutoInstall[] {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(AUTO_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry): AutoInstall[] => {
      if (typeof entry === "number") return [{ id: entry, scope: defaultAppScope }];
      if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "number") {
        const scope = (entry as { scope?: unknown }).scope;
        return [{ id: (entry as { id: number }).id, scope: isAppScope(scope) ? scope : defaultAppScope }];
      }
      return [];
    });
  } catch {
    return [];
  }
}

// 构建器首页：上传源码包、查看构建记录，日志在记录下方展开；成功的可以下载软件包或一键装到本平台。
export default function Home({ onSettings }: { onSettings: () => void }) {
  const installCtx = useInstallContext();
  const [me, setMe] = useState<Me | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [accessMap, setAccessMap] = useState<Record<string, AppAccess>>({});
  const accessMapRef = useRef(accessMap);
  accessMapRef.current = accessMap;
  const [loaded, setLoaded] = useState(false);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [expanded, setExpanded] = useState<Expanded | null>(null);
  const [error, setError] = useState("");
  // 选好的源码包，可以一次选多个；上传时一个一个传，每个成功后各自排进构建队列。
  const [files, setFiles] = useState<SourceItem[]>([]);
  // 上传没通过的源码包和原因，留在列表里给管理员看，改好后可以重新上传。
  const [fileErrors, setFileErrors] = useState(new Map<File, string>());
  // 正在上传第几个（从 0 开始），没在上传是 null。
  const [uploading, setUploading] = useState<number | null>(null);
  const busy = uploading !== null;
  // 点了“删除”或“取消”、等确认的记录。
  const [removing, setRemoving] = useState<number | null>(null);
  const [installing, setInstalling] = useState<number | null>(null);
  // 点了“安装”、等确认的记录；current 是平台上已装的同一个模块，没装过是 null。
  const [pending, setPending] = useState<{
    id: number;
    current: Installed | null;
    scope: AppScope;
  } | null>(null);
  // 模块声明了特权时，安装器先拒绝并列出特权，管理员确认后再带上 allowPrivileges 装一次。
  const [confirming, setConfirming] = useState<{
    id: number;
    privileges: string[];
    current: Installed | null;
    scope: AppScope;
  } | null>(null);
  const [notice, setNotice] = useState<InstallNotice | null>(null);
  const [auto, setAuto] = useState<AutoInstall[]>(loadAuto);
  // 正在查已装版本或安装的自动安装；查的时候 installing 还没设上，靠它避免同时开始装第二个。
  const autoBusy = useRef(false);

  // 构建中的记录在本页第一次读到时的起点（performance.now() 的时刻），用时从这里往后按秒走，之后刷新列表不再改它；刷新本页时重新从后端算。
  const starts = useRef(new Map<number, number>());

  function load() {
    api
      .builds()
      .then(({ data, serverTime }) => {
        const now = performance.now();
        for (const b of data)
          if (
            b.status === "building" &&
            b.startedAt &&
            !starts.current.has(b.id)
          )
            // 取整到秒：之后每秒的重画正好落在整秒后面一点，不会偶尔跳过一秒。
            starts.current.set(
              b.id,
              now -
                Math.round(
                  Math.max(0, serverTime - new Date(b.startedAt).getTime()) /
                    1000,
                ) *
                  1000,
            );
        setBuilds(data);
        setLoaded(true);
      })
      .catch((err) => setError(err.message));
  }

  // elapsed 返回构建用了几秒：结束了的用后端记的开始和结束时间，构建中的从本页的起点算到现在。
  function elapsed(b: Build) {
    if (!b.startedAt) return null;
    if (b.finishedAt)
      return (
        (new Date(b.finishedAt).getTime() - new Date(b.startedAt).getTime()) /
        1000
      );
    const start = starts.current.get(b.id);
    return start === undefined ? 0 : (performance.now() - start) / 1000;
  }

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch((err) => setError(err.message));
    api
      .rules()
      .then(setRules)
      .catch((err) => setError(err.message));
    const syncAccess = () => {
      portalApi
        .appAccess()
        .then(setAccessMap)
        .catch(() => {});
    };
    syncAccess();
    load();
    const onBuildsChanged = () => load();
    window.addEventListener(BUILDS_CHANGED_EVENT, onBuildsChanged);
    window.addEventListener(APPS_CHANGED_EVENT, syncAccess);
    return () => {
      window.removeEventListener(BUILDS_CHANGED_EVENT, onBuildsChanged);
      window.removeEventListener(APPS_CHANGED_EVENT, syncAccess);
    };
  }, []);

  useEffect(() => {
    setFiles((fs) =>
      fs.map((item) => {
        if (item.scopeTouched || !item.moduleId) return item;
        const existingScope = accessMap[item.moduleId]?.scope;
        return existingScope && existingScope !== item.scope ? { ...item, scope: existingScope } : item;
      }),
    );
  }, [accessMap]);

  // 有排队或构建中的记录时每隔几秒刷新一次列表，看状态有没有变。
  const running = builds.some(isRunning);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [running]);

  // 有构建中的记录时每秒重画一次，用时一秒一秒地走。
  const [, setTick] = useState(0);
  const building = builds.some((b) => b.status === "building");
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [building]);

  useEffect(() => {
    try {
      sessionStorage.setItem(AUTO_KEY, JSON.stringify(auto));
    } catch {
      // 浏览器不让存时只影响刷新后还记不记得，本页照常自动安装。
    }
  }, [auto]);

  // 等着自动安装的记录构建结束后，按上传顺序一次装一个；正在安装或等管理员确认时先不动，结束后再看下一个。
  // 构建器自己放到最后装：装它会换掉正在用的构建器，先装的话会打断后面的构建，还会停在确认上、挡住后面的安装。
  useEffect(() => {
    if (autoBusy.current || installing !== null || pending || confirming)
      return;
    const autoMap = new Map(auto.map((item) => [item.id, item]));
    const waiting = builds.filter((b) => autoMap.has(b.id));
    const done = waiting
      .filter((b) => !isRunning(b))
      .sort((x, y) => x.id - y.id);
    const b =
      done.find((b) => b.moduleId !== SELF_ID) ??
      (done.length === waiting.length ? done[0] : undefined);
    if (!b) return;
    const target = autoMap.get(b.id)!;
    setAuto((items) => items.filter((item) => item.id !== b.id));
    if (b.status !== "success") {
      setExpanded({ id: b.id, panel: "build" });
      return;
    }
    autoBusy.current = true;
    askInstall(b, true, target.scope).finally(() => (autoBusy.current = false));
  }, [builds, auto, installing, pending, confirming]);

  // 选了或拖进来几个文件，加在已选的后面，同一个文件不重复加；默认不勾选“构建并安装”。
  // 识别到平台已有模块时，默认权限范围沿用现有配置；新装应用保持“按权限访问”。
  function add(picked: File[]) {
    const same = (a: File, b: File) =>
      a.name === b.name &&
      a.size === b.size &&
      a.lastModified === b.lastModified;
    const fresh = picked.filter(
      (f, i) => picked.findIndex((o) => same(o, f)) === i,
    );
    const added: File[] = [];
    setFiles((fs) => {
      const next = fresh.filter((f) => !fs.some((o) => same(o.file, f)));
      added.push(...next);
      return [
        ...fs,
        ...next.map((file): SourceItem => ({
          file,
          installAfter: false,
          scope: defaultAppScope,
        })),
      ];
    });
    setError("");
    for (const file of new Set(added)) {
      void inspectDroppedZip(file)
        .then((inspected) => {
          if (inspected.iconUrl?.startsWith("blob:")) URL.revokeObjectURL(inspected.iconUrl);
          const moduleId = inspected.manifest?.id;
          if (!moduleId) return;
          setFiles((fs) =>
            fs.map((o) => {
              if (o.file !== file) return o;
              const existingScope = accessMapRef.current[moduleId]?.scope;
              return {
                ...o,
                moduleId,
                scope: !o.scopeTouched && existingScope ? existingScope : o.scope,
              };
            }),
          );
        })
        .catch(() => {});
    }
  }

  function removeFile(f: File) {
    setFiles((fs) => fs.filter((o) => o.file !== f));
    setFileErrors((m) => {
      const next = new Map(m);
      next.delete(f);
      return next;
    });
    setError("");
  }

  function toggleInstall(f: File, installAfter: boolean) {
    setFiles((fs) =>
      fs.map((o) => (o.file === f ? { ...o, installAfter } : o)),
    );
  }

  function changeScope(f: File, scope: AppScope) {
    setFiles((fs) => fs.map((o) => (o.file === f ? { ...o, scope, scopeTouched: true } : o)));
  }

  // 一个一个上传，每个通过检查的马上排进构建队列；没通过的留在列表里、写上原因，其他的照常上传。
  // 勾选了“构建并安装”的源码包在构建成功后按其选择的权限范围自动安装。
  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!files.length) return;
    setError("");
    setFileErrors(new Map());
    const failed = new Map<File, string>();
    let first: number | null = null;
    for (const [i, item] of files.entries()) {
      setUploading(i);
      try {
        const b = await api.upload(item.file);
        if (item.installAfter && me?.admin) {
          setAuto((items) => [
            ...items.filter((x) => x.id !== b.id),
            { id: b.id, scope: item.scope },
          ]);
        }
        first ??= b.id;
        load();
      } catch (err) {
        failed.set(item.file, err instanceof Error ? err.message : "上传失败");
      }
    }
    setUploading(null);
    setFiles((fs) => fs.filter((item) => failed.has(item.file)));
    setFileErrors(failed);
    if (failed.size)
      setError(
        `${failed.size} 个源码包没能上传，原因写在文件下面；改好后可以重新上传。`,
      );
    // 展开第一条新记录的日志，看得到构建开始了。
    if (first !== null) setExpanded({ id: first, panel: "build" });
  }

  async function remove(b: Build) {
    setRemoving(null);
    setError("");
    try {
      await api.removeBuild(b.id);
      setAuto((items) => items.filter((item) => item.id !== b.id));
      if (expanded?.id === b.id) setExpanded(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    }
  }

  function toggle(id: number, panel: Expanded["panel"]) {
    setExpanded(
      expanded?.id === id && expanded.panel === panel ? null : { id, panel },
    );
  }

  // 点“安装”先查平台上装的是哪个版本及现有权限范围，在记录下方请管理员确认：新装默认按权限访问，更新已有应用默认沿用现有权限范围。
  // 构建并安装（isAuto）时已经表明要装，直接安装；只有降级、或者装构建器自己时还有别的构建没结束，才照常请管理员确认。
  async function askInstall(
    b: Build,
    isAuto = false,
    scope?: AppScope,
  ) {
    setConfirming(null);
    setNotice(null);
    setError("");
    try {
      const [installed, latestAccess] = await Promise.all([
        api.installed(),
        scope === undefined ? portalApi.appAccess().catch(() => accessMapRef.current) : Promise.resolve(accessMapRef.current),
      ]);
      if (scope === undefined) setAccessMap(latestAccess);
      const current = installed.find((m) => m.id === b.moduleId) ?? null;
      const resolvedScope = scope ?? latestAccess[b.moduleId]?.scope ?? defaultAppScope;
      const downgrade =
        current !== null && compareVersions(b.version, current.version) < 0;
      if (isAuto && !downgrade && !(b.moduleId === SELF_ID && running))
        return install(b, false, current, resolvedScope);
      setPending({ id: b.id, current, scope: resolvedScope });
      setExpanded({ id: b.id, panel: "install" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取已安装的应用失败");
    }
  }

  // 一键安装：装完把结果和日志报给后端保存，记录上就会出现“安装日志”。
  // current 是平台上已装的同一个模块，用来决定装完后的提示；不传时从安装确认或特权确认里带过来。
  async function install(
    b: Build,
    allowPrivileges = false,
    current?: Installed | null,
    scope?: AppScope,
  ) {
    if (current === undefined)
      current =
        pending?.id === b.id
          ? pending.current
          : confirming?.id === b.id
            ? confirming.current
            : null;
    const targetScope =
      scope ??
      (pending?.id === b.id
        ? pending.scope
        : confirming?.id === b.id
          ? confirming.scope
          : defaultAppScope);
    setPending(null);
    setConfirming(null);
    setNotice(null);
    setInstalling(b.id);
    setExpanded({ id: b.id, panel: "install" });
    const taskKey = installCtx?.beginExternalTask({
      moduleId: b.moduleId,
      name: b.moduleName || b.moduleId,
      version: b.version,
      phase: "installing",
      progress: 0.12,
      isUpgrade: Boolean(current),
      buildId: b.id,
      source: "builder",
    });
    let currentProgress = 0.12;
    const progressTimer =
      taskKey && installCtx
        ? window.setInterval(() => {
            currentProgress = Math.min(0.94, currentProgress + (0.94 - currentProgress) * 0.065);
            installCtx.updateExternalTask(taskKey, { progress: currentProgress });
          }, 450)
        : undefined;
    let ok = false;
    let message: string;
    let log = "";
    try {
      const installedRes = await api.install(b, allowPrivileges);
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      if (taskKey && installCtx) installCtx.updateExternalTask(taskKey, { progress: 0.96 });
      log = installedRes.log;
      ok = true;
      const { accessError } = await finalizeModuleInstall(
        installedRes.module?.id ?? b.moduleId,
        installedRes.module?.version ?? b.version,
        me?.admin ? targetScope : undefined,
      );
      if (taskKey && installCtx) installCtx.completeExternalTask(taskKey);
      if (b.moduleId === SELF_ID)
        message = `构建器已更新为 ${b.version}，刷新本页后生效。`;
      else if (current)
        message = `${b.moduleName} 已更新为 ${b.version}，应用列表和已打开页签已自动刷新。`;
      else
        message = `${b.moduleName} ${b.version} 已安装，应用列表已自动刷新。`;
      if (accessError) message += `（权限范围设置失败：${accessError}）`;
    } catch (err) {
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      if (taskKey && installCtx) installCtx.abortExternalTask(taskKey);
      if (err instanceof ApiError && err.status === 409) {
        setConfirming({
          id: b.id,
          privileges: err.privileges,
          current,
          scope: targetScope,
        });
        setInstalling(null);
        return;
      }
      message = err instanceof Error ? err.message : "安装失败";
      if (err instanceof ApiError) log = err.log;
    }
    try {
      // 装的是构建器自己时，后端刚被换掉，网关要过一会儿才认出新容器，所以失败了隔两秒再试几次。
      await retry(
        () => api.saveInstall(b.id, ok, log),
        b.moduleId === SELF_ID ? 5 : 1,
      );
      setNotice({ id: b.id, ok, message });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "保存失败";
      setNotice({
        id: b.id,
        ok,
        message: `${message}（安装日志没能保存：${reason}）`,
        log,
      });
    }
    setInstalling(null);
    load();
  }

  return (
    <section className="builder-page">
      <Card
        title="上传源码包"
        extra={
          <Space>
            <Button href={skillUrl} icon={<DownloadOutlined />}>
              下载开发 Skill
            </Button>
            {me?.menus.includes("settings") && (
              <Button onClick={onSettings} icon={<SettingOutlined />}>
                设置
              </Button>
            )}
          </Space>
        }
      >
        <form className="stack" onSubmit={upload}>
          <Typography.Text type="secondary">
            服务器会按仓库里的 compose.yaml 和 Dockerfile 构建出软件包。模块的
            id、名称和版本都以源码包里的 module.yaml 为准。
          </Typography.Text>
          <FileDrop
            files={files}
            errors={fileErrors}
            uploading={uploading}
            canInstall={Boolean(me?.admin)}
            onAdd={add}
            onRemove={removeFile}
            onToggleInstall={toggleInstall}
            onChangeScope={changeScope}
            onError={setError}
          />
          <div className="actions">
            <Button
              type="primary"
              loading={busy}
              htmlType="submit"
              disabled={!files.length || busy}
            >
              {busy ? uploadingText(uploading, files.length) : "开始构建"}
            </Button>
          </div>
          {error && <Alert type="error" showIcon message={<>{error}</>} />}
        </form>
      </Card>

      <Card title="构建记录">
        <section className="stack">
          <div className="section-head">
            {rules && (
              <Typography.Text type="secondary">
                每个应用的成功和失败记录各保留最近 {rules.maxPackages} 个，超过{" "}
                {rules.maxDays} 天的自动删除，软件包和日志一起删除。
              </Typography.Text>
            )}
          </div>
          <List
            loading={!loaded && !error}
            dataSource={builds}
            locale={{ emptyText: "还没有构建过。" }}
            renderItem={(b) => {
              const open = expanded?.id === b.id ? expanded.panel : null;
              const retention = rules && retentionText(b, builds, rules);
              const seconds = elapsed(b);
              const autoItem = auto.find((item) => item.id === b.id);
              return (
                <List.Item key={b.id} className="build-row">
                  <div className="build-head">
                    <div className="build-title">
                      <span className="item-name">{b.moduleName}</span>
                      <Tag>{b.version}</Tag>
                      <Tag
                        className={
                          b.status === "building" ? "tag-progress" : undefined
                        }
                        color={
                          b.status === "success"
                            ? "success"
                            : b.status === "failed"
                              ? "error"
                              : b.status === "queued"
                                ? undefined
                                : "processing"
                        }
                      >
                        {statusText[b.status]}
                      </Tag>
                      {autoItem && (
                        <Tag>构建后安装 · {appScopeLabel[autoItem.scope]}</Tag>
                      )}
                      {installing === b.id ? (
                        <Tag className="tag-progress" color="processing">
                          安装中
                        </Tag>
                      ) : (
                        b.installStatus && (
                          <Tag
                            color={
                              b.installStatus === "success"
                                ? "success"
                                : "error"
                            }
                          >
                            {b.installStatus === "success"
                              ? "已安装"
                              : "安装失败"}
                          </Tag>
                        )
                      )}
                    </div>
                    {/* 每一项整体换行，“用时 3 分 10 秒”不会被拆到两行。 */}
                    <Typography.Text type="secondary" className="meta">
                      {[
                        b.moduleId,
                        b.createdBy,
                        formatTime(b.createdAt),
                        seconds !== null && `用时 ${formatDuration(seconds)}`,
                        b.status === "success" && formatSize(b.packageSize),
                      ]
                        .filter(Boolean)
                        .map((text, i) => (
                          <span key={i}>{text}</span>
                        ))}
                    </Typography.Text>
                    {retention && (
                      <Typography.Text type="secondary">
                        {retention}
                      </Typography.Text>
                    )}
                  </div>
                  <div className="actions">
                    {removing === b.id ? (
                      <>
                        <Button danger type="primary" onClick={() => remove(b)}>
                          {isRunning(b) ? "确认取消构建" : "确认删除"}
                        </Button>
                        <Button onClick={() => setRemoving(null)}>
                          {isRunning(b) ? "继续构建" : "不删除"}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button onClick={() => toggle(b.id, "build")}>
                          {open === "build" ? "收起日志" : "日志"}
                        </Button>
                        {(b.installStatus ||
                          installing === b.id ||
                          confirming?.id === b.id ||
                          pending?.id === b.id) && (
                          <Button onClick={() => toggle(b.id, "install")}>
                            {open === "install" ? "收起安装日志" : "安装日志"}
                          </Button>
                        )}
                        {b.status === "success" && (
                          <Button href={packageUrl(b.id)} download>
                            下载
                          </Button>
                        )}
                        {b.status === "success" && me?.admin && (
                          <Button
                            onClick={() => askInstall(b)}
                            disabled={installing !== null}
                          >
                            {b.installStatus ? "重新安装" : "安装"}
                          </Button>
                        )}
                        <Button
                          type="link"
                          danger
                          onClick={() => setRemoving(b.id)}
                          disabled={installing === b.id}
                        >
                          {isRunning(b) ? "取消" : "删除"}
                        </Button>
                      </>
                    )}
                  </div>
                  {open === "build" && <BuildLog id={b.id} onFinish={load} />}
                  {open === "install" && (
                    <div className="detail stack">
                      {installing === b.id && (
                        <Typography.Text type="secondary">
                          正在导入镜像并启动，可能需要一两分钟。关掉页面也不会中断安装。
                        </Typography.Text>
                      )}
                      {pending?.id === b.id && (
                        <InstallConfirm
                          build={b}
                          current={pending.current}
                          scope={pending.scope}
                          busy={b.moduleId === SELF_ID && running}
                          onScopeChange={(scope) =>
                            setPending((p) =>
                              p && p.id === b.id ? { ...p, scope } : p,
                            )
                          }
                          onConfirm={() => install(b)}
                          onCancel={() => setPending(null)}
                        />
                      )}
                      {confirming?.id === b.id && (
                        <div className="stack">
                          <Alert
                            type="error"
                            showIcon
                            message={
                              <>这个应用需要以下特权，确认后才会安装：</>
                            }
                          />
                          <ul>
                            {confirming.privileges.map((p) => (
                              <li key={p}>
                                <code>{p}</code>：
                                {privilegeInfo[p] ?? "平台不认识的特权"}
                              </li>
                            ))}
                          </ul>
                          <div className="actions">
                            <Button
                              danger
                              type="primary"
                              onClick={() => install(b, true)}
                            >
                              确认并安装
                            </Button>
                            <Button onClick={() => setConfirming(null)}>
                              取消
                            </Button>
                          </div>
                        </div>
                      )}
                      {notice?.id === b.id && (
                        <Alert
                          type={notice.ok ? "success" : "error"}
                          showIcon
                          message={notice.message}
                        />
                      )}
                      {notice?.id === b.id && notice.log !== undefined ? (
                        <pre className="log">
                          {notice.log || "安装器没有返回日志"}
                        </pre>
                      ) : (
                        b.installStatus && (
                          <InstallLog key={b.installedAt} build={b} />
                        )
                      )}
                    </div>
                  )}
                </List.Item>
              );
            }}
          />
        </section>
      </Card>
    </section>
  );
}

// FileDrop 是选源码包的区域：点一下打开选文件，也可以把 zip 拖进来，一次可以选多个。
// 选好的列在下方，每个显示文件名、大小，以及单独的“构建并安装”复选框与权限范围选择。
function FileDrop({
  files,
  errors,
  uploading,
  canInstall,
  onAdd,
  onRemove,
  onToggleInstall,
  onChangeScope,
  onError,
}: {
  files: SourceItem[];
  errors: Map<File, string>;
  uploading: number | null;
  canInstall: boolean;
  onAdd: (files: File[]) => void;
  onRemove: (f: File) => void;
  onToggleInstall: (f: File, installAfter: boolean) => void;
  onChangeScope: (f: File, scope: AppScope) => void;
  onError: (message: string) => void;
}) {
  const disabled = uploading !== null;

  function choose(list: File[]) {
    const picked = Array.from(list ?? []);
    const zips = picked.filter((f) => f.name.toLowerCase().endsWith(".zip"));
    if (zips.length) onAdd(zips);
    const skipped = picked.filter((f) => !zips.includes(f)).map((f) => f.name);
    if (skipped.length)
      onError(`只能上传 .zip 格式的源码包，没有加入：${skipped.join("、")}`);
  }

  return (
    <div className="stack files">
      {/* 与应用管理使用同一种上传控件；文件仍由本页统一校验和排队，不自动上传。 */}
      <Upload.Dragger
        className="source-upload"
        accept=".zip"
        multiple
        disabled={disabled}
        showUploadList={false}
        beforeUpload={(file, list) => {
          if (file === list[list.length - 1]) choose(list);
          return false;
        }}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">
          {files.length
            ? "点击或把源码包拖到这里，继续添加"
            : "点击或把源码包拖到这里，可以多选"}
        </p>
      </Upload.Dragger>
      {files.length > 0 && (
        <List
          size="small"
          bordered
          dataSource={files}
          renderItem={(item, i) => (
            <List.Item>
              <div className="file-row">
                <div className="file-info">
                  <Typography.Text strong>{item.file.name}</Typography.Text>
                  <Typography.Text type="secondary">
                    {formatSize(item.file.size)}
                    {uploading === i
                      ? " · 上传中…"
                      : uploading !== null && i > uploading
                        ? " · 等待上传"
                        : ""}
                  </Typography.Text>
                  {errors.has(item.file) && (
                    <Typography.Text type="danger">
                      {errors.get(item.file)}
                    </Typography.Text>
                  )}
                </div>
                <div className="file-actions">
                  {canInstall && (
                    <>
                      <Checkbox
                        checked={item.installAfter}
                        disabled={disabled}
                        onChange={(e) =>
                          onToggleInstall(item.file, e.target.checked)
                        }
                      >
                        构建并安装
                      </Checkbox>
                      {item.installAfter && (
                        <Select
                          size="small"
                          aria-label={`${item.file.name}权限范围`}
                          value={item.scope}
                          style={{ minWidth: 120 }}
                          disabled={disabled}
                          onChange={(scope) => onChangeScope(item.file, scope)}
                          options={appScopeOptions}
                        />
                      )}
                    </>
                  )}
                  <Button
                    size="small"
                    disabled={disabled}
                    aria-label={`去掉 ${item.file.name}`}
                    onClick={() => onRemove(item.file)}
                  >
                    移除
                  </Button>
                </div>
              </div>
            </List.Item>
          )}
        />
      )}
    </div>
  );
}

// uploadingText 是上传时按钮上的字，传多个时带上进度。
function uploadingText(index: number | null, total: number) {
  return total > 1 && index !== null
    ? `上传中 ${index + 1}/${total}…`
    : "上传中…";
}

// InstallConfirm 在安装前说明会发生什么：新装、重装、升级还是降级，装构建器自己时还要提醒会打断构建。
function InstallConfirm({
  build,
  current,
  scope,
  busy,
  onScopeChange,
  onConfirm,
  onCancel,
}: {
  build: Build;
  current: Installed | null;
  scope: AppScope;
  busy: boolean;
  onScopeChange: (scope: AppScope) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const diff = current ? compareVersions(build.version, current.version) : 0;
  let text = `安装 ${build.moduleName} ${build.version}？`;
  if (current && diff === 0)
    text = `平台上已经装了${build.moduleName} ${current.version}，重新安装一次？`;
  if (current && diff > 0)
    text = `把${build.moduleName}从 ${current.version} 升级到 ${build.version}？`;
  return (
    <div className="stack">
      <Typography.Text type={diff < 0 ? "danger" : undefined}>
        {current && diff < 0
          ? `平台上装的是更新的 ${current.version}，确定要降级到 ${build.version} 吗？`
          : text}
      </Typography.Text>
      {build.moduleId === SELF_ID && (
        <Alert
          type="warning"
          showIcon
          message={
            <>
              这会替换正在使用的构建器：安装期间正在进行的构建会中断，装完后要刷新本页才能用上新版本。
            </>
          }
        />
      )}
      {busy && (
        <Alert
          type="error"
          showIcon
          message={<>还有排队或构建中的记录，等它们结束后再安装构建器。</>}
        />
      )}
      <Space wrap align="center">
        <Typography.Text type="secondary">权限范围</Typography.Text>
        <Select
          aria-label={`${build.moduleName}权限范围`}
          value={scope}
          style={{ minWidth: 124 }}
          onChange={onScopeChange}
          options={appScopeOptions}
        />
      </Space>
      <div className="actions">
        <Button
          danger={diff < 0}
          type="primary"
          onClick={onConfirm}
          disabled={busy}
        >
          确认安装
        </Button>
        <Button onClick={onCancel}>取消</Button>
      </div>
    </div>
  );
}

// retry 最多调用 fn times 次，失败后隔两秒再试，最后一次的错误照常抛出。
async function retry(fn: () => Promise<void>, times: number) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= times) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// BuildLog 显示一次构建的日志，构建没结束时每两秒刷新，结束后通知列表刷新。
function BuildLog({ id, onFinish }: { id: number; onFinish: () => void }) {
  const { message } = AntApp.useApp();
  const [detail, setDetail] = useState<BuildDetail | null>(null);
  const [error, setError] = useState("");
  const [fixing, setFixing] = useState(false);

  const reloadDetail = () =>
    api
      .build(id)
      .then(setDetail)
      .catch((err) => setError(err.message));

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () =>
      api
        .build(id)
        .then((d) => {
          if (stopped) return;
          setDetail(d);
          if (isRunning(d.build)) timer = setTimeout(poll, 2000);
          else onFinish();
        })
        .catch((err) => !stopped && setError(err.message));
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id]);

  async function applyMirrors(suggested: BuildArg[]) {
    setFixing(true);
    try {
      const current = await api.settings();
      const merged = [...current.buildArgs];
      for (const arg of suggested) {
        if (!merged.some((x) => x.name === arg.name)) {
          merged.push(arg);
        }
      }
      await api.saveSettings({ ...current, buildArgs: merged });
      message.success("已配置国内镜像源，重新上传源码包即可构建");
      reloadDetail();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "配置失败");
    } finally {
      setFixing(false);
    }
  }

  async function pruneCache() {
    setFixing(true);
    try {
      const res = await api.pruneCache();
      message.success(`已清理缓存，释放 ${formatSize(res.reclaimedBytes)}`);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "清理失败");
    } finally {
      setFixing(false);
    }
  }

  async function copyForAI(b: Build, logText: string, hintText: string) {
    const prompt = buildAIPrompt("构建失败", b, b.error, hintText, logText);
    try {
      await navigator.clipboard.writeText(prompt);
      message.success("已复制诊断信息");
    } catch {
      message.error("复制失败");
    }
  }

  if (!detail)
    return (
      <div className="detail">
        {error ? (
          <Alert type="error" showIcon message={<>{error}</>} />
        ) : (
          <Typography.Text type="secondary">加载中…</Typography.Text>
        )}
      </div>
    );
  const b = detail.build;
  const diag = detail.diagnosis;
  const hintText = diag?.summary || b.hint;
  return (
    <div className="detail stack">
      {b.status === "queued" && (
        <Typography.Text type="secondary">
          前面还有构建在进行，轮到时会自动开始。
        </Typography.Text>
      )}
      {b.status === "building" && (
        <Alert
          type="info"
          showIcon
          icon={<LoadingOutlined spin />}
          message="正在构建中，日志会自动实时刷新（首次构建需下载基础环境与依赖，耗时可能较长，请耐心等待）"
        />
      )}
      {b.status === "failed" && (
        <Alert type="error" showIcon message={<>{b.error}</>} />
      )}
      {hintText && <Alert type="warning" showIcon message={<span style={{ whiteSpace: "pre-line" }}>{hintText}</span>} />}
      {b.status === "failed" && (
        <Space wrap>
          {diag?.suggestedArgs && diag.suggestedArgs.length > 0 && (
            <Button
              type="primary"
              size="small"
              icon={<ThunderboltOutlined />}
              loading={fixing}
              onClick={() => applyMirrors(diag.suggestedArgs!)}
            >
              一键配置国内源（{diag.suggestedArgs.map((a) => a.name).join("、")}）
            </Button>
          )}
          {diag?.canPruneCache && (
            <Button
              size="small"
              icon={<ClearOutlined />}
              loading={fixing}
              onClick={pruneCache}
            >
              清理构建缓存
            </Button>
          )}
          <Button
            size="small"
            icon={<CopyOutlined />}
            onClick={() => copyForAI(b, detail.log, hintText)}
          >
            复制给 AI 修复
          </Button>
        </Space>
      )}
      {detail.logTruncated && (
        <Typography.Text type="secondary">
          日志太长，只显示最后一段。
        </Typography.Text>
      )}
      <pre className="log">{detail.log || "还没有日志"}</pre>
    </div>
  );
}

// InstallLog 显示在构建器里最近一次安装的结果和日志。
function InstallLog({ build }: { build: Build }) {
  const { message } = AntApp.useApp();
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .installLog(build.id)
      .then((r) => setLog(r.log))
      .catch((err) => setError(err.message));
  }, [build.id]);

  async function copyForAI() {
    const prompt = buildAIPrompt("安装失败", build, "", "", log ?? "");
    try {
      await navigator.clipboard.writeText(prompt);
      message.success("已复制诊断信息");
    } catch {
      message.error("复制失败");
    }
  }

  return (
    <>
      <Space wrap>
        <Typography.Text type="secondary">
          {build.installedBy} 于{" "}
          {build.installedAt && formatTime(build.installedAt)}{" "}
          {build.installStatus === "success" ? "安装成功" : "安装失败"}
        </Typography.Text>
        {build.installStatus === "failed" && log !== null && (
          <Button size="small" icon={<CopyOutlined />} onClick={copyForAI}>
            复制给 AI 修复
          </Button>
        )}
      </Space>
      {error && <Alert type="error" showIcon message={<>{error}</>} />}
      {log !== null && <pre className="log">{log || "安装器没有返回日志"}</pre>}
    </>
  );
}

function buildAIPrompt(stage: string, b: Build, errMsg: string, hint: string, log: string) {
  const tailLines = log.trim().split("\n").slice(-80).join("\n");
  const parts = [
    `我的 Vibebooth 应用在「${stage}」阶段出错，请帮我定位并修改代码：`,
    `- 应用：${b.moduleName}（id: ${b.moduleId}，version: ${b.version}）`,
    errMsg ? `- 错误：${errMsg}` : "",
    hint ? `- 平台诊断：${hint}` : "",
    "请遵循 Vibebooth platform: 1 规范修复问题（检查 module.yaml、compose.yaml、Dockerfile 的 ARG 镜像源及 /api/<id>/health 健康检查）。",
    tailLines ? `\n\`\`\`text\n${tailLines}\n\`\`\`` : "",
  ];
  return parts.filter(Boolean).join("\n");
}

// retentionText 按保留规则说明这条记录什么时候会被删除；排队和构建中的不会被清理。
function retentionText(b: Build, builds: Build[], rules: Rules) {
  if (isRunning(b)) return "";
  // 列表按 id 从新到旧排，同一应用同一结果里排第几就是第几新的。
  const rank = builds.filter(
    (o) => o.moduleId === b.moduleId && o.status === b.status && o.id >= b.id,
  ).length;
  const expires = new Date(b.createdAt);
  expires.setDate(expires.getDate() + rules.maxDays);
  const date = expires.toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
  });
  if (rank === rules.maxPackages) {
    const next = b.status === "success" ? "成功" : "失败";
    return `保留到 ${date}；这个应用再${next}构建一次就会删除`;
  }
  return `保留到 ${date}`;
}

function formatTime(s: string) {
  return new Date(s).toLocaleString("zh-CN", { hour12: false });
}

// formatDuration 把构建用的秒数写成“几分几秒”。
function formatDuration(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function formatSize(bytes: number) {
  return bytes >= 1 << 20
    ? `${(bytes / (1 << 20)).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}
