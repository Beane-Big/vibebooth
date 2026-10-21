export type Person = {
  id: number;
  name: string;
  note: string;
  photo: string;
};

export type PersonInput = Pick<Person, "name" | "note" | "photo">;

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
  list: () => request<Person[]>("/api/people/persons"),
  create: (input: PersonInput) => request<Person>("/api/people/persons", { method: "POST", body: JSON.stringify(input) }),
  update: (id: number, input: PersonInput) =>
    request<Person>(`/api/people/persons/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  remove: (id: number) => request<void>(`/api/people/persons/${id}`, { method: "DELETE" }),
};
