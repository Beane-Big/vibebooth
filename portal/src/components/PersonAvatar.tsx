import { Avatar } from "antd";
import type { Person } from "../api";

// PersonAvatar 是成员的头像：有照片显示照片，没有时显示名字的第一个字。用户应用和顶栏共用。
export default function PersonAvatar({ person, size = 40 }: { person: Pick<Person, "name" | "photo">; size?: number }) {
  return person.photo ? (
    <Avatar size={size} src={person.photo} style={{ flex: "none" }} />
  ) : (
    <Avatar size={size} style={{ backgroundColor: "var(--accent)", flex: "none" }}>
      {person.name.slice(0, 1) || "?"}
    </Avatar>
  );
}
