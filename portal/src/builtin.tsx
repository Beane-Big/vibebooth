import type { ReactNode } from "react";
import { TeamOutlined } from "@ant-design/icons";

// 平台自带的应用：代码在门户里，交互和模块一样，出现在应用页，点开是一个标签页。
// 标签页里直接渲染门户的页面，不用内嵌页；按住 Ctrl / Cmd 点击时在浏览器新标签页打开同一个网址。
export type BuiltinApp = {
  id: string;
  name: string;
  description: string;
  url: string;
  icon: ReactNode;
  adminOnly: boolean;
};

export const builtinApps: BuiltinApp[] = [
  {
    id: "users",
    name: "用户",
    description: "维护家庭成员和他们的登录账号",
    url: "/admin/users",
    icon: <TeamOutlined />,
    adminOnly: true,
  },
];

export const isBuiltinURL = (url: string) => builtinApps.some((app) => app.url === url);
