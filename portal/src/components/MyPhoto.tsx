import { useRef, useState } from "react";
import { App as AntApp, Button, Flex } from "antd";
import { api } from "../api";
import { resizePhoto } from "../photo";
import PersonAvatar from "./PersonAvatar";

// MyPhoto 换自己的头像：选好照片立即保存，会自动裁成正方形。各个应用里看到的都是这张照片。顶栏和“用户”应用共用。
export default function MyPhoto({ name, photo, onChange }: { name: string; photo: string; onChange: (photo: string) => void }) {
  const { message } = AntApp.useApp();
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function save(next: () => Promise<string>, success: string) {
    setSaving(true);
    try {
      const res = await api.setMyPhoto(await next());
      onChange(res.photo);
      message.success(success);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Flex vertical align="center" gap={16} style={{ padding: "16px 0 8px" }}>
      <PersonAvatar person={{ name, photo }} size={96} />
      <Flex gap={8}>
        <Button type="primary" loading={saving} onClick={() => fileInput.current?.click()}>
          选择照片
        </Button>
      </Flex>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) save(() => resizePhoto(file), "头像已更换");
        }}
      />
    </Flex>
  );
}
