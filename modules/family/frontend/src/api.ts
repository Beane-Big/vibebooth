export type Member = {
  personId: number;
  name: string;
  photo: string;
  score: number;
};

export type BoardView = {
  members: Member[];
  peopleAvailable: boolean;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// 调用本模块后端的对内接口；登录 Cookie 由浏览器自动带上，网关负责校验。
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (res.status === 401) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? "请求失败");
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  board: () => request<BoardView>("/api/family/scores"),
  change: (personId: number, delta: number) =>
    request<{ personId: number; score: number }>(`/api/family/scores/${personId}`, {
      method: "POST",
      body: JSON.stringify({ delta }),
    }),
  reset: () => request<void>("/api/family/scores", { method: "DELETE" }),
};
