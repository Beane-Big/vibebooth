#!/usr/bin/env node
// Vibebooth 主题包自检与打包脚本（零外部依赖，Node.js 20+）
// 用法：node check-and-pack-theme.mjs [主题目录] [--check-only] [--out <输出路径.zip>]

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ALLOWED_YAML_KEYS = new Set(["platform", "id", "name", "description", "version", "script", "style", "preview"]);
const ALLOWED_ASSET_EXTS = new Set([".svg", ".png", ".jpg", ".webp", ".gif", ".woff", ".woff2", ".css", ".js", ".json"]);
const PREVIEW_EXTS = new Set([".svg", ".png", ".jpg", ".webp"]);
const FILE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const MAX_UNPACKED_BYTES = 20 * 1024 * 1024;

const args = process.argv.slice(2);
let targetDir = ".";
let checkOnly = false;
let outPath = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--check-only") checkOnly = true;
  else if (args[i] === "--out" && args[i + 1]) outPath = args[++i];
  else if (!args[i].startsWith("-")) targetDir = args[i];
}

const root = path.resolve(targetDir);
const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`目录不存在：${root}`);
  process.exit(1);
}

function stripComment(str) {
  let quote = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === quote && str[i - 1] !== "\\") quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(str[i - 1]))) {
      return str.slice(0, i).trim();
    }
  }
  return str.trim();
}

const manifestPath = path.join(root, "theme.yaml");
const meta = {};

if (!fs.existsSync(manifestPath)) {
  fail("缺少根目录 theme.yaml");
} else {
  const raw = fs.readFileSync(manifestPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const clean = stripComment(line);
    if (!clean) continue;
    const colon = clean.indexOf(":");
    if (colon === -1) {
      fail(`theme.yaml 格式异常：${clean}`);
      continue;
    }
    const key = clean.slice(0, colon).trim();
    const val = clean.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    if (!ALLOWED_YAML_KEYS.has(key)) {
      fail(`theme.yaml 包含不支持的字段：${key}`);
      continue;
    }
    meta[key] = val;
  }

  if (meta.platform && meta.platform !== "1") {
    fail(`theme.yaml 的 platform 应为 1（当前为 ${meta.platform}）`);
  }
  if (!meta.id) {
    fail("theme.yaml 缺少 id");
  } else if (!/^[a-z][a-z0-9-]{1,30}$/.test(meta.id) || meta.id === "classic" || meta.id === "tiles") {
    fail(`theme.yaml 的 id "${meta.id}" 不合法（小写字母开头、2–31 位小写字母/数字/连字符，且不能为 classic、tiles）`);
  }
  if (!meta.name) fail("theme.yaml 缺少 name");
  if (!meta.version || !/^\d+\.\d+\.\d+$/.test(meta.version)) {
    fail(`theme.yaml 的 version "${meta.version || ""}" 必须是 x.y.z 格式`);
  }
  if (!meta.script && !meta.style) {
    fail("theme.yaml 中 script 和 style 至少需要填写一个");
  }

  const checkRootFile = (field, allowedExts) => {
    const f = meta[field];
    if (!f) return;
    if (!FILE_NAME_RE.test(f) || f.startsWith(".") || !allowedExts.has(path.extname(f).toLowerCase())) {
      fail(`theme.yaml 的 ${field} 文件名或后缀不合法：${f}`);
      return;
    }
    if (!fs.existsSync(path.join(root, f))) {
      fail(`theme.yaml 声明的 ${field} 文件不存在：${f}`);
    }
  };
  checkRootFile("script", new Set([".js"]));
  checkRootFile("style", new Set([".css"]));
  checkRootFile("preview", PREVIEW_EXTS);
  if (!meta.preview) warn("建议添加 preview 预览图（如 preview.svg 或 preview.png）");
}

// 收集要打进主题包的文件（严格按规范：根目录仅 theme.yaml + 声明文件，外加 assets/ 合法文件）
const entries = [];
let totalSize = 0;

function addFile(rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return;
  totalSize += fs.statSync(full).size;
  entries.push({ full, name: rel.split(path.sep).join("/") });
}

if (fs.existsSync(manifestPath)) addFile("theme.yaml");
for (const field of ["script", "style", "preview"]) {
  if (meta[field] && fs.existsSync(path.join(root, meta[field]))) {
    addFile(meta[field]);
  }
}

const assetsDir = path.join(root, "assets");
if (fs.existsSync(assetsDir) && fs.statSync(assetsDir).isDirectory()) {
  function walkAssets(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isSymbolicLink()) {
        fail(`assets/ 中不支持符号链接：${ent.name}`);
        continue;
      }
      if (!FILE_NAME_RE.test(ent.name) || ent.name.startsWith(".")) {
        fail(`assets/ 中文件名不合法：${ent.name}`);
        continue;
      }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walkAssets(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!ALLOWED_ASSET_EXTS.has(ext)) {
          fail(`assets/ 中包含不允许的文件类型：${path.relative(root, full)}`);
          continue;
        }
        if (ext === ".js" && !meta.script) {
          fail(`未声明 script 时，assets/ 中也不能包含 .js 文件：${path.relative(root, full)}`);
          continue;
        }
        addFile(path.relative(root, full));
      }
    }
  }
  walkAssets(assetsDir);
}

if (totalSize > MAX_UNPACKED_BYTES) {
  fail(`主题包解压总大小超过 20 MB（当前 ${(totalSize / (1024 * 1024)).toFixed(1)} MB）`);
}

for (const w of warnings) console.warn(`[提示] ${w}`);
for (const e of errors) console.error(`[错误] ${e}`);

if (errors.length > 0) {
  console.error(`\n主题自检未通过，共 ${errors.length} 处错误，请修复后重试。`);
  process.exit(1);
}

console.log(`主题自检通过：${meta.id} ${meta.version}（${warnings.length} 条提示）`);
if (checkOnly) process.exit(0);

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const raw = fs.readFileSync(file.full);
    const nameBuf = Buffer.from(file.name, "utf8");
    const crc = crc32(raw);
    const compressed = zlib.deflateRawSync(raw);
    const useDeflate = compressed.length < raw.length;
    const data = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((0o100000 | 0o644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralSize = centralParts.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

const defaultOut = path.join(root, `${meta.id}-${meta.version}-theme.zip`);
const zipOut = outPath ? path.resolve(outPath) : defaultOut;
const zipBuf = createZip(entries);
fs.mkdirSync(path.dirname(zipOut), { recursive: true });
fs.writeFileSync(zipOut, zipBuf);
console.log(`已生成主题包：${zipOut}（${entries.length} 个文件，${(zipBuf.length / 1024).toFixed(1)} KB）`);
