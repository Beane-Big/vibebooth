import type { ReactNode } from "react";
import { BarChartOutlined, ContactsOutlined, SettingOutlined, SkinOutlined } from "@ant-design/icons";
import { hasPerm, isAdmin, type Me, type PlatformPerm } from "./api";

// 平台自带的应用：代码在门户里，交互和模块一样，出现在应用页，点开是一个标签页。
// 标签页里直接渲染门户的页面，不用内嵌页；按住 Ctrl / Cmd 点击时在浏览器新标签页打开同一个网址。
export type BuiltinApp = {
  id: string;
  name: string;
  description: string;
  url: string;
  icon: ReactNode;
  // 彩色方块皮肤里图标底色的渐变，从左上到右下两种颜色。
  tint: [string, string];
  // 要有平台的哪项功能权限才能看到，everyone 表示所有人都能看到；不写表示只给管理员。
  perm?: PlatformPerm | "everyone";
  embedded?: boolean;
};

export const builtinApps: BuiltinApp[] = [
  {
    id: "applications",
    name: "应用管理",
    description: "安装、管理和构建应用",
    url: "/applications",
    icon: <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" aria-hidden="true">
      <path d="m8 4 11 16M15 4 4 20M3 15h12" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
    </svg>,
    tint: ["#54bcff", "#3168e9"],
    perm: "modules",
  },
  {
    id: "contacts",
    name: "联系人",
    description: "你的联系人",
    url: "/contacts",
    icon: <ContactsOutlined />,
    tint: ["#54bcff", "#3168e9"],
    perm: "everyone",
  },
  {
    id: "settings",
    name: "设置",
    description: "平台的系统设置",
    url: "/settings",
    icon: <SettingOutlined />,
    tint: ["#ff7a6b", "#9b4dff"],
    perm: "settings",
  },
  // 每个人在这里给自己选主题；有“应用管理”权限的人还能上传和卸载主题包。
  {
    id: "themes",
    name: "主题",
    description: "换门户的外观",
    url: "/themes",
    icon: <SkinOutlined />,
    tint: ["#ffc75f", "#ff5f8f"],
    perm: "everyone",
  },
  // 活跃度统计只给管理员：谁在什么时候用了哪个应用属于每个人的隐私。
  {
    id: "stats",
    name: "统计",
    description: "谁在用平台、用哪些应用、用了多久",
    url: "/stats",
    icon: <BarChartOutlined />,
    tint: ["#5ee7b0", "#0f9f8f"],
  },
];

// 旧入口与子视图快捷路径统一指向合并后的平台应用。
export const builtinAliases: Record<string, string> = {
  "/applications/build": "/applications",
  "/applications/build/settings": "/applications",
  "/applications/dev": "/applications",
  "/admin/modules": "/applications",
  "/apps/builder/": "/applications",
  "/admin/users": "/contacts",
  "/contacts/self": "/contacts",
  "/contacts/accounts": "/contacts",
};

// 这个人能看到的自带应用。其他人输入网址也只会看到首页，接口本身也会拒绝。
export const builtinAppsFor = (me: Me) =>
  builtinApps.filter((app) => (app.perm === "everyone" || (app.perm ? hasPerm(me, app.perm) : isAdmin(me))));

export const isBuiltinURL = (url: string) => builtinApps.some((app) => !app.embedded && app.url === url);
