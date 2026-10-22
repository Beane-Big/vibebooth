import type { ReactNode } from "react";
import { api, isAdmin, type User } from "../api";

export type Tab = "apps" | "settings" | "modules" | "users";

// 门户各页面共用的顶栏和内容区。“应用管理”和“用户”只对管理员显示。
export default function Layout({
  user,
  active,
  showSettings,
  onLogout,
  children,
}: {
  user: User;
  active: Tab;
  showSettings: boolean;
  onLogout: () => void;
  children: ReactNode;
}) {
  async function logout() {
    await api.logout();
    onLogout();
  }

  const tabs: { id: Tab; label: string; href: string; shown: boolean }[] = [
    { id: "apps", label: "应用", href: "/", shown: true },
    { id: "settings", label: "设置", href: "/settings", shown: showSettings || active === "settings" },
    { id: "modules", label: "应用管理", href: "/admin/modules", shown: isAdmin(user) },
    { id: "users", label: "用户", href: "/admin/users", shown: isAdmin(user) },
  ];

  return (
    <>
      <header className="topbar">
        <span className="title">家庭应用门户</span>
        <nav className="tabs">
          {tabs
            .filter((t) => t.shown)
            .map((t) => (
              <a key={t.id} className={t.id === active ? "tab active" : "tab"} href={t.href}>
                {t.label}
              </a>
            ))}
        </nav>
        <span className="spacer" />
        <span className="muted">{user.displayName}</span>
        <button className="link" onClick={logout}>
          退出
        </button>
      </header>
      <main className="content">{children}</main>
    </>
  );
}
