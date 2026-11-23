import { useState } from "react";
import { Tabs } from "antd";
import { isAdmin, type Me } from "../api";
import Modules from "./Modules";
import BuilderHome from "./builder/Home";
import BuilderSettings from "./builder/Settings";
import "./builder/styles.css";

// 安装管理和构建共用一个应用入口，构建器仅管理员可用。
export default function AppManagement({ me, entryPath }: { me: Me; entryPath: string }) {
  const [settings, setSettings] = useState(entryPath === "/applications/build/settings");
  return (
    <Tabs
      defaultActiveKey={isAdmin(me) && entryPath.startsWith("/applications/build") ? "build" : "modules"}
      items={[
        {
          key: "modules",
          label: "应用管理",
          children: <Modules canManageAccess={isAdmin(me)} />,
        },
        ...(isAdmin(me)
          ? [{
              key: "build",
              label: "应用构建",
              children: settings
                ? <BuilderSettings onBack={() => setSettings(false)} />
                : <BuilderHome onSettings={() => setSettings(true)} />,
            }]
          : []),
      ]}
    />
  );
}
