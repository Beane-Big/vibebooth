import { useEffect, useState } from "react";
import { Tabs } from "antd";
import { isAdmin, type Me } from "../api";
import Modules from "./Modules";
import AppDevGuide from "./builder/AppDevGuide";
import BuilderHome from "./builder/Home";
import BuilderSettings from "./builder/Settings";
import "./builder/styles.css";

const seenKey = (userId: number) => `vb:app-mgmt-seen:${userId}`;

function initialTab(admin: boolean, entryPath: string, userId: number, hasModules: boolean): string {
  if (!admin) return "modules";
  if (entryPath === "/applications/dev") return "dev";
  if (entryPath.startsWith("/applications/build")) return "build";
  try {
    const seen = localStorage.getItem(seenKey(userId)) === "1";
    if (!seen && !hasModules) {
      localStorage.setItem(seenKey(userId), "1");
      return "dev";
    }
    if (!seen) localStorage.setItem(seenKey(userId), "1");
  } catch {}
  return "modules";
}

// 安装管理、构建与开发指引共用一个应用入口，构建与开发仅管理员可用。
export default function AppManagement({
  me,
  entryPath,
  hasModules = false,
}: {
  me: Me;
  entryPath: string;
  hasModules?: boolean;
}) {
  const admin = isAdmin(me);
  const [activeKey, setActiveKey] = useState(() => initialTab(admin, entryPath, me.id, hasModules));
  const [settings, setSettings] = useState(entryPath === "/applications/build/settings");

  useEffect(() => {
    if (!admin) return;
    if (entryPath === "/applications/dev") {
      setActiveKey("dev");
    } else if (entryPath.startsWith("/applications/build")) {
      setActiveKey("build");
      setSettings(entryPath === "/applications/build/settings");
    }
  }, [admin, entryPath]);

  return (
    <Tabs
      activeKey={activeKey}
      onChange={setActiveKey}
      items={[
        {
          key: "modules",
          label: "应用管理",
          children: <Modules canManageAccess={admin} />,
        },
        ...(admin
          ? [
              {
                key: "build",
                label: "应用构建",
                children: settings ? (
                  <BuilderSettings onBack={() => setSettings(false)} />
                ) : (
                  <BuilderHome onSettings={() => setSettings(true)} />
                ),
              },
              {
                key: "dev",
                label: "应用开发",
                children: <AppDevGuide onGoBuild={() => setActiveKey("build")} />,
              },
            ]
          : []),
      ]}
    />
  );
}
