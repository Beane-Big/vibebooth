import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Person } from "./api";

const PHOTO_SIZE = 320;

// 把照片居中裁成正方形并压缩成 JPEG，避免把手机原图（几 MB）存进数据库。
function resizePhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const c = document.createElement("canvas");
      c.width = PHOTO_SIZE;
      c.height = PHOTO_SIZE;
      const side = Math.min(img.width, img.height);
      c.getContext("2d")!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取这张图片"));
    };
    img.src = url;
  });
}

export default function App() {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [editing, setEditing] = useState<Person | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      setPeople(await api.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }

  useEffect(() => {
    load();
  }, []);

  function startEdit(p: Person) {
    setEditing(p);
    setName(p.name);
    setNote(p.note);
    setPhoto(p.photo);
    setError("");
    nameInput.current?.focus();
  }

  function resetForm() {
    setEditing(null);
    setName("");
    setNote("");
    setPhoto("");
    setError("");
  }

  async function pickPhoto(file: File | undefined) {
    if (!file) return;
    try {
      setPhoto(await resizePhoto(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法读取这张图片");
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const input = { name, note, photo };
      if (editing) await api.update(editing.id, input);
      else await api.create(input);
      resetForm();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(p: Person) {
    if (!confirm(`确定删除「${p.name}」吗？其他应用里此人的数据（如分数）将不再显示。`)) return;
    try {
      await api.remove(p.id);
      if (editing?.id === p.id) resetForm();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    }
  }

  return (
    <>
      <header className="topbar">
        <a className="back" href="/">
          ← 返回门户
        </a>
        <span className="title">人员管理</span>
      </header>
      <main className="content stack">
        <section className="card stack">
          <h1>{editing ? "编辑人员" : "添加人员"}</h1>
          <form className="form" onSubmit={submit}>
            <button type="button" className="photo-picker" onClick={() => fileInput.current?.click()} aria-label="选择照片">
              <Avatar name={name} photo={photo} />
            </button>
            <input ref={nameInput} value={name} onChange={(e) => setName(e.target.value)} placeholder="姓名" maxLength={30} required />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（可选）" maxLength={200} />
            <button type="submit" disabled={submitting}>
              {editing ? "保存" : "添加"}
            </button>
            {photo && (
              <button type="button" className="link danger" onClick={() => setPhoto("")}>
                去掉照片
              </button>
            )}
            {editing && (
              <button type="button" className="link" onClick={resetForm}>
                取消编辑
              </button>
            )}
          </form>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              pickPhoto(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <p className="muted">点头像选择照片，会自动裁成正方形。</p>
          {error && <p className="error">{error}</p>}
        </section>
        <section className="card">
          {people && people.length === 0 && <p className="muted">还没有人员，先在上面添加。</p>}
          <ul className="list">
            {people?.map((p) => (
              <li key={p.id} className="row">
                <Avatar name={p.name} photo={p.photo} />
                <span className="row-text">
                  <span className="row-name">{p.name}</span>
                  {p.note && <span className="muted">{p.note}</span>}
                </span>
                <button className="link" onClick={() => startEdit(p)}>
                  编辑
                </button>
                <button className="link danger" onClick={() => remove(p)}>
                  删除
                </button>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </>
  );
}

function Avatar({ name, photo }: { name: string; photo: string }) {
  if (photo) return <img className="avatar" src={photo} alt="" />;
  return <span className="avatar placeholder">{name.slice(0, 1) || "?"}</span>;
}
