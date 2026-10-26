import type { ReactNode } from "react";
import { SettingOutlined, TeamOutlined } from "@ant-design/icons";
import { hasPerm, isAdmin, type Me, type PlatformPerm } from "./api";

// 平台自带的应用：代码在门户里，交互和模块一样，出现在应用页，点开是一个标签页。
// 标签页里直接渲染门户的页面，不用内嵌页；按住 Ctrl / Cmd 点击时在浏览器新标签页打开同一个网址。
export type BuiltinApp = {
  id: string;
  name: string;
  description: string;
  url: string;
  icon: ReactNode;
  // 要有平台的哪项功能权限才能看到；不写表示只给管理员。
  perm?: PlatformPerm;
};

export const builtinApps: BuiltinApp[] = [
  // 能管账号的人可以给自己勾上任何权限，等于管理员，所以“用户”不单独开放，只给管理员。
  {
    id: "users",
    name: "用户",
    description: "维护家庭成员和他们的登录账号",
    url: "/admin/users",
    icon: <TeamOutlined />,
  },
  {
    id: "settings",
    name: "设置",
    description: "平台的系统设置和应用管理",
    url: "/settings",
    icon: <SettingOutlined />,
    perm: "settings",
  },
];

// 以前单独存在、现在并进别的自带应用的网址：“应用管理”在“设置”里。
export const builtinAliases: Record<string, string> = { "/admin/modules": "/settings" };

// 这个人能看到的自带应用。其他人输入网址也只会看到首页，接口本身也会拒绝。
export const builtinAppsFor = (me: Me) =>
  builtinApps.filter((app) => (app.perm ? hasPerm(me, app.perm) : isAdmin(me)));

export const isBuiltinURL = (url: string) => builtinApps.some((app) => app.url === url);
