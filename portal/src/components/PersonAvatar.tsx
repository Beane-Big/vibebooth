import { Avatar } from "antd";
import type { Person } from "../api";

// 按字符字形高度区分垂直居中方式：拉丁字母（尤其小写字母）在常规行盒里偏下，按字形边界裁剪才能真正居中。
function charClass(ch: string) {
  if (/^[A-Z0-9?bdfhiklt]$/.test(ch)) return "person-avatar-char person-avatar-cap";
  if (/^[acemnorsuvwxz]$/.test(ch)) return "person-avatar-char person-avatar-ex";
  if (/^[gpqy]$/.test(ch)) return "person-avatar-char person-avatar-desc";
  if (ch === "j") return "person-avatar-char person-avatar-j";
  return "person-avatar-char";
}

// PersonAvatar 是成员的头像：有照片显示照片，没有时显示名字的第一个字。用户应用和顶栏共用。
export default function PersonAvatar({ person, size = 40 }: { person: Pick<Person, "name" | "photo">; size?: number }) {
  if (person.photo) {
    return <Avatar size={size} src={person.photo} style={{ flex: "none" }} />;
  }
  const ch = person.name.trim().slice(0, 1) || "?";
  return (
    <Avatar
      size={size}
      className="person-avatar"
      style={{ backgroundColor: "var(--accent)", flex: "none", fontSize: Math.round(size * 0.5), lineHeight: 1 }}
    >
      <span className={charClass(ch)}>{ch}</span>
    </Avatar>
  );
}
