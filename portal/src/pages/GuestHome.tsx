import type { MouseEvent, ReactNode } from "react";
import {
  AppstoreOutlined,
  BgColorsOutlined,
  CloudServerOutlined,
  ContactsOutlined,
  ExportOutlined,
  LockOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import type { App } from "../api";
import AppIcon from "../components/AppIcon";
import type { AppTab } from "../components/AppTabs";
import { inPlace } from "../components/Layout";

type Props = {
  apps: App[];
  onOpen: (tab: AppTab) => void;
};

// GuestHome 是未登录访客的产品首页。首屏介绍可私有部署的平台，公开应用放在后面作为真实体验入口。
export default function GuestHome({ apps, onOpen }: Props) {
  return (
    <div className="guest-home">
      <section className="guest-hero" aria-labelledby="guest-title">
        <div className="guest-intro">
          <h1 id="guest-title">
            <span>部署你自己的</span>
            <span>Web 应用平台</span>
          </h1>
          <p>Vibebooth 用来安装、管理和运行多个 Web 应用，可以部署在自己的服务器上。</p>
          <div className="guest-actions">
            <a className="guest-primary-action" href="https://github.com/Beane-Big/vibebooth#readme" target="_blank" rel="noreferrer">
              查看部署方式
              <ExportOutlined aria-hidden="true" />
            </a>
            <a className="guest-secondary-action" href="#guest-apps">体验公开应用</a>
          </div>
          <div className="guest-points" aria-label="Vibebooth 平台特点">
            <span><strong>私有部署</strong>运行在自己的服务器</span>
            <span><strong>应用管理</strong>安装、升级和打开应用</span>
            <span><strong>自定义开发</strong>用脚手架创建自己的应用</span>
          </div>
        </div>

        <div className="guest-platform" aria-label="Vibebooth 平台组成">
          <div className="guest-platform-bar">
            <span className="guest-window-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>你的 Vibebooth</span>
            <span className="guest-running">运行中</span>
          </div>
          <div className="guest-platform-grid">
            <PlatformPart icon={<AppstoreOutlined />} title="应用入口" detail="集中打开已安装应用" />
            <PlatformPart icon={<ContactsOutlined />} title="联系人" detail="连接平台内的账号" />
            <PlatformPart icon={<CloudServerOutlined />} title="应用管理" detail="安装、构建和升级" />
            <PlatformPart icon={<BgColorsOutlined />} title="主题" detail="统一平台外观" />
          </div>
          <div className="guest-platform-base">
            <SafetyCertificateOutlined aria-hidden="true" />
            <span>账号、权限和应用由自己的平台管理</span>
          </div>
        </div>
      </section>

      <section className="guest-experience" id="guest-apps" aria-labelledby="guest-apps-title">
        <div className="guest-experience-head">
          <div>
            <h2 id="guest-apps-title">体验这个 Vibebooth</h2>
            <p>以下是当前平台公开的应用。</p>
          </div>
          <span>{apps.length ? `${apps.length} 个应用` : "暂无公开应用"}</span>
        </div>
        {apps.length ? (
          <div className="guest-app-list">
            {apps.map((app) => <GuestApp key={app.id} app={app} onOpen={onOpen} />)}
          </div>
        ) : (
          <div className="guest-empty">
            <strong>暂时没有公开应用</strong>
            <span>登录后可以查看已为账号开放的应用。</span>
          </div>
        )}
      </section>
    </div>
  );
}

function PlatformPart({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="guest-platform-part">
      <span className="guest-platform-icon">{icon}</span>
      <span><strong>{title}</strong><small>{detail}</small></span>
    </div>
  );
}

// 应用条目沿用平台 AppIcon 和原来的打开规则；登录要求只作状态说明，真正的拦截仍由门户统一处理。
function GuestApp({ app, onOpen }: { app: App; onOpen: (tab: AppTab) => void }) {
  const tab = { url: app.url, title: app.name };
  const status = !app.healthy ? "暂不可用" : app.loginRequired ? "登录后使用" : "直接打开";
  const open = (e: MouseEvent) => {
    if (!inPlace(e)) return;
    e.preventDefault();
    onOpen(tab);
  };

  return (
    <a className={`guest-app${app.healthy ? "" : " unhealthy"}`} href={app.url} onClick={open}>
      <AppIcon app={{ name: app.name, icon: app.icon, mask: app.glyph, color: app.color }} />
      <span className="guest-app-copy">
        <strong>{app.name}</strong>
        <span>{app.description || status}</span>
      </span>
      <span className="guest-app-action">
        {app.loginRequired && app.healthy && <LockOutlined aria-hidden="true" />}
        <span>{status}</span>
        <RightOutlined aria-hidden="true" />
      </span>
    </a>
  );
}
