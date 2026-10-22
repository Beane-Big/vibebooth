export type User = {
  id: number;
  username: string;
  displayName: string;
  roles: string[];
  disabled: boolean;
};

export const isAdmin = (user: User) => user.roles.includes("admin");

export type App = {
  id: string;
  name: string;
  description: string;
  version: string;
  url: string;
  icon?: string;
  healthy: boolean;
  settingsUrl?: string;
};

// 应用管理页：安装器返回的已安装模块。
export type InstalledModule = {
  id: string;
  name: string;
  description: string;
  version: string;
  requires: string[];
  requiredBy: string[];
  healthy: boolean;
};

// 用户页：某个人对每个菜单的默认值、单独设置和最终结果。override 为 null 表示跟随默认。
export type MenuGrant = {
  id: string;
  name: string;
  path: string;
  default: boolean;
  override: boolean | null;
  allowed: boolean;
};

export type UserMenus = {
  admin: boolean;
  modules: { id: string; name: string; menus: MenuGrant[] }[];
};

export type UserInput = {
  username?: string;
  displayName: string;
  password?: string;
  admin: boolean;
  disabled?: boolean;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    // 安装器失败时附带的安装日志。
    public log = "",
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 上传文件时由浏览器自己设置 multipart 的 Content-Type。
  const json = !(init?.body instanceof FormData);
  const res = await fetch(path, {
    ...init,
    headers: { ...(json && { "Content-Type": "application/json" }), ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? "请求失败", body.log);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const put = (path: string, body: unknown) => request<void>(path, { method: "PUT", body: JSON.stringify(body) });

export const api = {
  me: () => request<User>("/api/platform/me"),
  apps: () => request<App[]>("/api/platform/apps"),
  login: (username: string, password: string) =>
    request<User>("/api/platform/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<void>("/api/platform/auth/logout", { method: "POST" }),

  // 应用管理（只有管理员能调用）
  modules: () => request<InstalledModule[]>("/api/platform/installer/modules"),
  installModule: (file: File) => {
    const form = new FormData();
    form.append("package", file);
    return request<{ module: InstalledModule; log: string }>("/api/platform/installer/modules", {
      method: "POST",
      body: form,
    });
  },
  uninstallModule: (id: string, purge: boolean) =>
    request<{ log: string }>(`/api/platform/installer/modules/${id}?purge=${purge}`, { method: "DELETE" }),

  // 用户与权限（只有管理员能调用）
  users: () => request<User[]>("/api/platform/users"),
  createUser: (input: UserInput) =>
    request<User>("/api/platform/users", { method: "POST", body: JSON.stringify(input) }),
  updateUser: (id: number, input: UserInput) => put(`/api/platform/users/${id}`, input),
  setPassword: (id: number, password: string) => put(`/api/platform/users/${id}/password`, { password }),
  userMenus: (id: number) => request<UserMenus>(`/api/platform/users/${id}/menus`),
  // allowed 为 null 表示恢复默认值。
  setUserMenu: (id: number, module: string, menu: string, allowed: boolean | null) =>
    put(`/api/platform/users/${id}/menus`, { module, menu, allowed }),
};
