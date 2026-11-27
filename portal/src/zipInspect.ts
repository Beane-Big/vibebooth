// 在浏览器里直接读取 zip 文件的中央目录，无需上传即可区分构建成果物（模块包）与源码包，
// 并提取 module.yaml 和图标供确认弹窗与安装动效展示。
// 只按需切片读取文件尾部和几 KB 的元数据，2 GB 的模块包也能在几毫秒内完成识别。

export type ZipPackageKind = "package" | "source" | "theme" | "invalid";

export type InspectedManifest = {
  id: string;
  name: string;
  version: string;
  description: string;
  icon: string;
  privileges: string[];
  hasFrontend: boolean;
};

export type InspectedZip = {
  kind: ZipPackageKind;
  file: File;
  manifest?: InspectedManifest;
  // 从 zip 里解出的图标临时地址；调用方在任务结束后应 revokeObjectURL。
  iconUrl?: string;
  error?: string;
};

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

const SIG_LOCAL = 0x04034b50;
const SIG_CD = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;

const MAX_TAIL = 65557; // 22 bytes EOCD + 65535 bytes max comment
const MAX_CD_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ICON_BYTES = 512 * 1024;

const decoder = new TextDecoder("utf-8");

function readUint64LE(view: DataView, offset: number): number {
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);
  return hi * 0x100000000 + lo;
}

async function listZipEntries(blob: Blob): Promise<ZipEntry[]> {
  if (blob.size < 22) throw new Error("不是有效的 zip 文件");
  const tailStart = Math.max(0, blob.size - MAX_TAIL);
  const tailBuf = await blob.slice(tailStart, blob.size).arrayBuffer();
  const tail = new DataView(tailBuf);

  let eocdPos = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_EOCD) {
      const commentLen = tail.getUint16(i + 20, true);
      if (i + 22 + commentLen === tail.byteLength) {
        eocdPos = i;
        break;
      }
    }
  }
  if (eocdPos < 0) throw new Error("不是有效的 zip 文件");

  let cdSize = tail.getUint32(eocdPos + 12, true);
  let cdOffset = tail.getUint32(eocdPos + 16, true);
  const entryCount16 = tail.getUint16(eocdPos + 10, true);

  if (cdSize === 0xffffffff || cdOffset === 0xffffffff || entryCount16 === 0xffff) {
    const locPos = eocdPos - 20;
    if (locPos >= 0 && tail.getUint32(locPos, true) === SIG_ZIP64_LOCATOR) {
      const z64Offset = readUint64LE(tail, locPos + 8);
      if (z64Offset >= 0 && z64Offset + 56 <= blob.size) {
        const z64Buf = await blob.slice(z64Offset, z64Offset + 56).arrayBuffer();
        const z64 = new DataView(z64Buf);
        if (z64.getUint32(0, true) === SIG_ZIP64_EOCD) {
          cdSize = readUint64LE(z64, 40);
          cdOffset = readUint64LE(z64, 48);
        }
      }
    }
  }

  if (cdSize > MAX_CD_BYTES || cdOffset < 0 || cdOffset + cdSize > blob.size) {
    throw new Error("zip 目录结构异常");
  }

  const cdBuf = await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
  const cd = new DataView(cdBuf);
  const cdBytes = new Uint8Array(cdBuf);
  const entries: ZipEntry[] = [];

  let pos = 0;
  while (pos + 46 <= cd.byteLength) {
    if (cd.getUint32(pos, true) !== SIG_CD) break;
    const method = cd.getUint16(pos + 10, true);
    let compressedSize = cd.getUint32(pos + 20, true);
    let uncompressedSize = cd.getUint32(pos + 24, true);
    const nameLen = cd.getUint16(pos + 28, true);
    const extraLen = cd.getUint16(pos + 30, true);
    const commentLen = cd.getUint16(pos + 32, true);
    let localHeaderOffset = cd.getUint32(pos + 42, true);

    const nameStart = pos + 46;
    const extraStart = nameStart + nameLen;
    const nextPos = extraStart + extraLen + commentLen;
    if (nextPos > cd.byteLength) break;

    const name = decoder.decode(cdBytes.subarray(nameStart, extraStart));

    if (
      (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) &&
      extraLen >= 4
    ) {
      let ep = extraStart;
      const extraEnd = extraStart + extraLen;
      while (ep + 4 <= extraEnd) {
        const id = cd.getUint16(ep, true);
        const sz = cd.getUint16(ep + 2, true);
        ep += 4;
        if (id === 0x0001 && ep + sz <= extraEnd) {
          let p = ep;
          if (uncompressedSize === 0xffffffff && p + 8 <= ep + sz) {
            uncompressedSize = readUint64LE(cd, p);
            p += 8;
          }
          if (compressedSize === 0xffffffff && p + 8 <= ep + sz) {
            compressedSize = readUint64LE(cd, p);
            p += 8;
          }
          if (localHeaderOffset === 0xffffffff && p + 8 <= ep + sz) {
            localHeaderOffset = readUint64LE(cd, p);
          }
          break;
        }
        ep += sz;
      }
    }

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    pos = nextPos;
  }

  return entries;
}

async function readZipEntry(blob: Blob, entry: ZipEntry, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (entry.compressedSize > maxBytes || entry.uncompressedSize > maxBytes) return null;
  if (entry.localHeaderOffset < 0 || entry.localHeaderOffset + 30 > blob.size) return null;

  const hdrBuf = await blob.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer();
  const hdr = new DataView(hdrBuf);
  if (hdr.getUint32(0, true) !== SIG_LOCAL) return null;

  const nameLen = hdr.getUint16(26, true);
  const extraLen = hdr.getUint16(28, true);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > blob.size) return null;

  const raw = new Uint8Array(await blob.slice(dataStart, dataEnd).arrayBuffer());
  if (entry.method === 0) return raw;
  if (entry.method === 8 && typeof DecompressionStream !== "undefined") {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } catch {
      return null;
    }
    const out = new Uint8Array(new ArrayBuffer(total));
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }
  return null;
}

function unquoteYaml(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"')) {
    const end = trimmed.lastIndexOf('"');
    if (end > 0) {
      try {
        return JSON.parse(trimmed.slice(0, end + 1));
      } catch {
        return trimmed.slice(1, end);
      }
    }
  }
  if (trimmed.startsWith("'")) {
    const end = trimmed.lastIndexOf("'");
    if (end > 0) return trimmed.slice(1, end).replace(/''/g, "'");
  }
  // 去掉未加引号值后面的行内注释。
  return trimmed.replace(/\s+#.*$/, "").trim();
}

// 从 module.yaml 提取展示所需的顶层字段；严格校验仍由服务端完成。
export function parseManifestPreview(text: string): InspectedManifest {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const result: InspectedManifest = {
    id: "",
    name: "",
    version: "",
    description: "",
    icon: "",
    privileges: [],
    hasFrontend: false,
  };

  let section: "" | "privileges" | "services" = "";
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      section = "";
      const match = /^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(line);
      if (!match) continue;
      const [, key, rest] = match;
      const val = rest.trim();
      switch (key) {
        case "id":
          result.id = unquoteYaml(val);
          break;
        case "name":
          result.name = unquoteYaml(val);
          break;
        case "version":
          result.version = unquoteYaml(val);
          break;
        case "description":
          result.description = unquoteYaml(val);
          break;
        case "icon":
          result.icon = unquoteYaml(val);
          break;
        case "privileges":
          if (val.startsWith("[") && val.endsWith("]")) {
            result.privileges = val
              .slice(1, -1)
              .split(",")
              .map((s) => unquoteYaml(s))
              .filter(Boolean);
          } else if (!val) {
            section = "privileges";
          }
          break;
        case "services":
          if (val.includes("frontend")) result.hasFrontend = true;
          else section = "services";
          break;
      }
      continue;
    }

    const trimmed = line.trim();
    if (section === "privileges" && trimmed.startsWith("-")) {
      const item = unquoteYaml(trimmed.slice(1));
      if (item) result.privileges.push(item);
    } else if (section === "services" && indent <= 4 && /^frontend\s*:/.test(trimmed)) {
      result.hasFrontend = true;
    }
  }

  return result;
}

function iconMime(filename: string): string | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return null;
}

function findSingleTopPrefix(entries: ZipEntry[]): string | null {
  let top = "";
  for (const e of entries) {
    if (!e.name || e.name.startsWith("__MACOSX/")) continue;
    const slash = e.name.indexOf("/");
    if (slash <= 0) return null;
    const dir = e.name.slice(0, slash);
    if (top && top !== dir) return null;
    top = dir;
  }
  return top ? `${top}/` : null;
}

// 识别用户拖入的 zip：构建成果物包（module.yaml + compose.yaml + images.tar）、
// 源码包（module.yaml + compose.yaml，无 images.tar，支持 GitHub 单层目录）或主题包（theme.yaml）。
export async function inspectDroppedZip(file: File): Promise<InspectedZip> {
  let entries: ZipEntry[];
  try {
    entries = await listZipEntries(file);
  } catch (err) {
    return { kind: "invalid", file, error: err instanceof Error ? err.message : "不是有效的 zip 文件" };
  }

  const byName = new Map(entries.map((e) => [e.name, e]));

  let kind: ZipPackageKind = "invalid";
  let prefix = "";

  if (byName.has("module.yaml") && byName.has("compose.yaml") && byName.has("images.tar")) {
    kind = "package";
    prefix = "";
  } else if (byName.has("module.yaml") && byName.has("compose.yaml")) {
    kind = "source";
    prefix = "";
  } else {
    const top = findSingleTopPrefix(entries);
    if (top && byName.has(`${top}module.yaml`) && byName.has(`${top}compose.yaml`)) {
      if (byName.has(`${top}images.tar`)) {
        return {
          kind: "invalid",
          file,
          error: "模块安装包里的 module.yaml、compose.yaml 和 images.tar 必须直接位于压缩包根目录",
        };
      }
      kind = "source";
      prefix = top;
    } else if (byName.has("theme.yaml") || (top && byName.has(`${top}theme.yaml`))) {
      return {
        kind: "theme",
        file,
        error: "检测到门户主题包，请前往「外观」页面上传安装",
      };
    } else {
      return {
        kind: "invalid",
        file,
        error: "未在压缩包中找到 module.yaml 和 compose.yaml，不是有效的 Vibebooth 应用包或源码包",
      };
    }
  }

  const manifestEntry = byName.get(`${prefix}module.yaml`);
  let manifest: InspectedManifest | undefined;
  let iconUrl: string | undefined;

  if (manifestEntry) {
    const manifestBytes = await readZipEntry(file, manifestEntry, MAX_MANIFEST_BYTES);
    if (manifestBytes) {
      manifest = parseManifestPreview(decoder.decode(manifestBytes));
      const iconPath = manifest.icon.replace(/^\.\//, "");
      if (iconPath && !iconPath.includes("..") && !iconPath.startsWith("/")) {
        const mime = iconMime(iconPath);
        const iconEntry = byName.get(`${prefix}${iconPath}`);
        if (mime && iconEntry) {
          const iconBytes = await readZipEntry(file, iconEntry, MAX_ICON_BYTES);
          if (iconBytes) {
            iconUrl = URL.createObjectURL(new Blob([iconBytes], { type: mime }));
          }
        }
      }
    }
  }

  return { kind, file, manifest, iconUrl };
}
