export type User = {
  id: number;
  username: string;
  displayName: string;
  roles: string[];
  disabled: boolean;
  // 账号属于哪个人员，没有关联时为 null。一个人员可以有多个账号。
  personId: number | null;
};

// 人员：家庭成员等。照片是压缩后的 JPEG（data URL），没有时为空。
export type Person = {
  id: number;
  name: string;
  note: string;
  photo: string;
};

export type PersonInput = Pick<Person, "name" | "note" | "photo">;

export const isAdmin = (user: User) => user.roles.includes("admin");

// 当前登录的人：登录和 /me 接口在账号信息之外还带上平台自己的功能权限（管理员总有全部）。
export type Me = User & { perms: string[] };

// 平台自己的功能权限，和 core/menus.go 里的 platformModule 一致。
export type PlatformPerm = "settings" | "modules";

export const hasPerm = (me: Me, perm: PlatformPerm) => me.perms.includes(perm);

export type App = {
  id: string;
  name: string;
  description: string;
  version: string;
  url: string;
  icon?: string;
  healthy: boolean;
};

// 应用管理页：安装器返回的已安装模块。
export type InstalledModule = {
  id: string;
  name: string;
  description: string;
  version: string;
  requires: string[];
  optional: string[];
  requiredBy: string[];
  privileges: string[];
  healthy: boolean;
};

// 模块能声明的特权，以及安装前给管理员看的说明。
export const privilegeInfo: Record<string, string> = {
  "docker-build": "在服务器上构建镜像。它碰不到平台自己的程序，但能替换其他应用的镜像，只安装你信任的模块。",
};

// 用户页：某个人对一项功能权限或一个菜单的默认值、单独设置和最终结果。override 为 null 表示跟随默认。
export type Grant = {
  id: string;
  name: string;
  description?: string;
  default: boolean;
  override: boolean | null;
  allowed: boolean;
};

// 平台排在第一组（id 为 platform）。menus 里只有能单独设置的菜单，跟着功能权限走的菜单不列出。
export type UserMenus = {
  admin: boolean;
  modules: { id: string; name: string; perms: Grant[]; menus: Grant[] }[];
};

export type UserInput = {
  username?: string;
  displayName: string;
  password?: string;
  admin: boolean;
  disabled?: boolean;
  // 只在新建账号时用：同时关联到这个人员。
  personId?: number;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    // 安装器失败时附带的安装日志。
    public log = "",
    // 模块需要特权、等管理员确认时（409），列出需要的特权。
    public privileges: string[] = [],
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
    throw new ApiError(res.status, body.error ?? "请求失败", body.log, body.privileges);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const put = (path: string, body: unknown) => request<void>(path, { method: "PUT", body: JSON.stringify(body) });

export const api = {
  me: () => request<Me>("/api/platform/me"),
  apps: () => request<App[]>("/api/platform/apps"),
  login: (username: string, password: string) =>
    request<Me>("/api/platform/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<void>("/api/platform/auth/logout", { method: "POST" }),

  // 应用管理（要有平台的“应用管理”权限）
  modules: () => request<InstalledModule[]>("/api/platform/installer/modules"),
  installModule: (file: File, allowPrivileges = false) => {
    const form = new FormData();
    form.append("package", file);
    if (allowPrivileges) form.append("allowPrivileges", "true");
    return request<{ module: InstalledModule; log: string }>("/api/platform/installer/modules", {
      method: "POST",
      body: form,
    });
  },
  uninstallModule: (id: string, purge: boolean) =>
    request<{ log: string }>(`/api/platform/installer/modules/${id}?purge=${purge}`, { method: "DELETE" }),

  // 人员、账号与权限（只有管理员能调用）
  persons: () => request<Person[]>("/api/platform/persons"),
  createPerson: (input: PersonInput) =>
    request<Person>("/api/platform/persons", { method: "POST", body: JSON.stringify(input) }),
  updatePerson: (id: number, input: PersonInput) =>
    request<Person>(`/api/platform/persons/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deletePerson: (id: number) => request<void>(`/api/platform/persons/${id}`, { method: "DELETE" }),
  // personId 为 null 表示解除关联。
  setUserPerson: (id: number, personId: number | null) => put(`/api/platform/users/${id}/person`, { personId }),
  users: () => request<User[]>("/api/platform/users"),
  createUser: (input: UserInput) =>
    request<User>("/api/platform/users", { method: "POST", body: JSON.stringify(input) }),
  updateUser: (id: number, input: UserInput) => put(`/api/platform/users/${id}`, input),
  setPassword: (id: number, password: string) => put(`/api/platform/users/${id}/password`, { password }),
  userMenus: (id: number) => request<UserMenus>(`/api/platform/users/${id}/menus`),
  // allowed 为 null 表示恢复默认值。
  setUserMenu: (id: number, module: string, menu: string, allowed: boolean | null) =>
    put(`/api/platform/users/${id}/menus`, { module, menu, allowed }),
  setUserPerm: (id: number, module: string, perm: string, allowed: boolean | null) =>
    put(`/api/platform/users/${id}/perms`, { module, perm, allowed }),
};
