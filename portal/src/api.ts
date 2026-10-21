export type User = {
  id: number;
  username: string;
  displayName: string;
  roles: string[];
};

export type App = {
  id: string;
  name: string;
  description: string;
  version: string;
  url: string;
  icon?: string;
  healthy: boolean;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? "请求失败");
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  me: () => request<User>("/api/platform/me"),
  apps: () => request<App[]>("/api/platform/apps"),
  login: (username: string, password: string) =>
    request<User>("/api/platform/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<void>("/api/platform/auth/logout", { method: "POST" }),
};
