import { useEffect, useState, type FormEvent } from "react";
import { api, isAdmin, type MenuGrant, type User, type UserMenus } from "../api";

// 用户页：给使用者开账号、重置密码、停用账号，并按人勾选能看到哪些应用的哪些菜单。
export default function Users({ me }: { me: User }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<number | null>(null);

  function load() {
    api
      .users()
      .then(setUsers)
      .catch((err) => setError(err.message));
  }
  useEffect(load, []);

  const current = users?.find((u) => u.id === selected);

  return (
    <div className="stack">
      <CreateUser onCreated={(u) => {
        load();
        setSelected(u.id);
      }} />
      <div className="card section">
        <h2>用户</h2>
        {error && <p className="error">{error}</p>}
        <ul className="list">
          {users?.map((u) => (
            <li key={u.id} className={u.id === selected ? "list-item selected" : "list-item"}>
              <button className="list-main plain" onClick={() => setSelected(u.id === selected ? null : u.id)}>
                <span className="app-name">
                  {u.displayName}
                  {isAdmin(u) && <span className="tag">管理员</span>}
                  {u.disabled && <span className="badge">已停用</span>}
                </span>
                <span className="muted">{u.username}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {current && <UserDetail key={current.id} user={current} isMe={current.id === me.id} onSaved={load} />}
    </div>
  );
}

function CreateUser({ onCreated }: { onCreated: (u: User) => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [admin, setAdmin] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const u = await api.createUser({ username, displayName, password, admin });
      setUsername("");
      setDisplayName("");
      setPassword("");
      setAdmin(false);
      onCreated(u);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    }
  }

  return (
    <form className="card section" onSubmit={submit}>
      <h2>新建用户</h2>
      <div className="form-grid">
        <label>
          用户名（登录用）
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" required />
        </label>
        <label>
          显示名称
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="不填则同用户名" />
        </label>
        <label>
          初始密码（至少 8 位）
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
        </label>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
        管理员（拥有全部菜单，能管理应用和用户）
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="submit">创建</button>
      </div>
    </form>
  );
}

function UserDetail({ user, isMe, onSaved }: { user: User; isMe: boolean; onSaved: () => void }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [admin, setAdmin] = useState(isAdmin(user));
  const [disabled, setDisabled] = useState(user.disabled);
  const [password, setPassword] = useState("");
  const [menus, setMenus] = useState<UserMenus | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function loadMenus() {
    api
      .userMenus(user.id)
      .then(setMenus)
      .catch((err) => setMessage({ ok: false, text: err.message }));
  }
  useEffect(loadMenus, [user.id]);

  async function act(action: () => Promise<void>, success: string) {
    setMessage(null);
    try {
      await action();
      setMessage({ ok: true, text: success });
      onSaved();
      loadMenus();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "操作失败" });
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    act(() => api.updateUser(user.id, { displayName, admin, disabled }), "已保存");
  }

  function resetPassword(e: FormEvent) {
    e.preventDefault();
    act(() => api.setPassword(user.id, password), "密码已重置，该用户需要用新密码重新登录").then(() => setPassword(""));
  }

  // 勾选结果和默认值相同时直接恢复默认，数据库里只留和默认不同的设置。
  function toggle(module: string, menu: MenuGrant) {
    const next = !menu.allowed;
    act(() => api.setUserMenu(user.id, module, menu.id, next === menu.default ? null : next), "菜单权限已更新");
  }

  return (
    <div className="card section">
      <h2>{user.displayName}</h2>
      {message && <p className={message.ok ? "success" : "error"}>{message.text}</p>}

      <form className="stack-sm" onSubmit={save}>
        <label>
          显示名称
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} disabled={isMe} />
          管理员
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} disabled={isMe} />
          停用（不能登录，已登录的设备立即退出）
        </label>
        {isMe && <p className="muted">不能取消自己的管理员，也不能停用自己。</p>}
        <div className="row">
          <button type="submit">保存</button>
        </div>
      </form>

      <form className="row" onSubmit={resetPassword}>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="新密码，至少 8 位" autoComplete="new-password" required />
        <button className="secondary" type="submit">
          重置密码
        </button>
      </form>

      <h3>菜单权限</h3>
      {menus?.admin && <p className="muted">管理员拥有全部菜单。</p>}
      {menus && menus.modules.length === 0 && <p className="muted">还没有安装任何应用。</p>}
      {menus?.modules.map((m) => (
        <div key={m.id} className="menu-group">
          <span className="app-name">{m.name}</span>
          {m.menus.map((menu) => (
            <div key={menu.id} className="row">
              <label className="checkbox">
                <input type="checkbox" checked={menu.allowed} disabled={menus.admin} onChange={() => toggle(m.id, menu)} />
                {menu.name}
              </label>
              {!menus.admin && (menu.override === null ? (
                <span className="tag">默认</span>
              ) : (
                <button className="link" onClick={() => act(() => api.setUserMenu(user.id, m.id, menu.id, null), "已恢复默认")}>
                  恢复默认（{menu.default ? "有" : "无"}）
                </button>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
