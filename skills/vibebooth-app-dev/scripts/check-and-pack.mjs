#!/usr/bin/env node
// Vibebooth 应用源码自检与打包脚本（零外部依赖，Node.js 20+）
// 用法：node check-and-pack.mjs [应用目录] [--check-only] [--out <输出路径.zip>]

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const RESERVED_IDS = new Set([
  "platform", "core", "portal", "traefik", "postgres", "socket", "installer", "build", "builder",
]);
const ALLOWED_COMPOSE_KEYS = new Set([
  "image", "build", "environment", "command", "volumes", "depends_on", "healthcheck", "restart", "user",
]);
const FORBIDDEN_COMPOSE_KEYS = new Set([
  "ports", "expose", "networks", "network_mode", "labels", "privileged", "cap_add", "devices", "pid", "ipc",
]);
const IGNORE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".nuxt", ".venv", "venv", "__pycache__", ".idea", ".vscode",
]);
const IGNORE_FILES = new Set([".DS_Store", "Thumbs.db"]);

const args = process.argv.slice(2);
let targetDir = ".";
let checkOnly = false;
let outPath = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--check-only") {
    checkOnly = true;
  } else if (args[i] === "--out" && args[i + 1]) {
    outPath = args[++i];
  } else if (!args[i].startsWith("-")) {
    targetDir = args[i];
  }
}

const root = path.resolve(targetDir);
const errors = [];
const warnings = [];

function fail(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }

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

// 1. 检查 module.yaml
const manifestPath = path.join(root, "module.yaml");
let modId = "";
let modVersion = "";
let modIcon = "";
const declaredServices = [];

if (!fs.existsSync(manifestPath)) {
  fail("缺少根目录 module.yaml");
} else {
  const raw = fs.readFileSync(manifestPath, "utf8");
  const getScalar = (key) => {
    const m = raw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? stripComment(m[1]).replace(/^["']|["']$/g, "") : "";
  };
  modId = getScalar("id");
  const modName = getScalar("name");
  modVersion = getScalar("version");
  modIcon = getScalar("icon");

  if (!modId) {
    fail("module.yaml 缺少 id");
  } else if (!/^[a-z][a-z0-9-]{1,30}$/.test(modId)) {
    fail(`module.yaml 的 id "${modId}" 不合法：须小写字母开头，仅含小写字母、数字和连字符，长度 2–31`);
  } else if (RESERVED_IDS.has(modId)) {
    fail(`module.yaml 的 id "${modId}" 为平台保留名，请更换`);
  }

  if (!modName) fail("module.yaml 缺少 name");
  if (!modVersion) {
    fail("module.yaml 缺少 version");
  } else if (!/^\d+\.\d+\.\d+$/.test(modVersion)) {
    fail(`module.yaml 的 version "${modVersion}" 必须是 x.y.z 格式`);
  }

  if (!modIcon) {
    warn("module.yaml 未声明 icon（建议在根目录提供 icon.svg）");
  } else {
    const iconFull = path.join(root, modIcon);
    if (!fs.existsSync(iconFull)) {
      fail(`module.yaml 声明的图标文件不存在：${modIcon}`);
    } else if (modIcon.endsWith(".svg")) {
      const svg = fs.readFileSync(iconFull, "utf8");
      if (/<script[\s>]/i.test(svg)) fail(`${modIcon} 不能包含 <script>`);
      if (/<text[\s>]/i.test(svg)) warn(`${modIcon} 包含 <text>，建议将文字转为路径以保证跨平台显示一致`);
      if (/<image[\s>]/i.test(svg) || /<style[\s>]/i.test(svg)) {
        warn(`${modIcon} 包含 <image> 或 <style>，门户主题可能无法自动换色`);
      }
    }
  }

  if (/^\s{2}frontend\s*:/m.test(raw)) declaredServices.push("frontend");
  if (/^\s{2}backend\s*:/m.test(raw)) declaredServices.push("backend");
  if (declaredServices.length === 0) {
    fail("module.yaml 的 services 中至少需要声明 frontend 或 backend");
  }
}

// 2. 检查 compose.yaml
const composePath = path.join(root, "compose.yaml");
const buildTargets = [];

if (!fs.existsSync(composePath)) {
  fail("缺少根目录 compose.yaml");
} else {
  const raw = fs.readFileSync(composePath, "utf8");
  const lines = raw.split(/\r?\n/);

  // 检查除 ${VERSION} 外的 $（忽略注释）
  const codeOnly = lines.map((l) => stripComment(l)).join("\n");
  const cleanedDollar = codeOnly.replace(/\$\{VERSION\}/g, "");
  if (cleanedDollar.includes("$")) {
    fail("compose.yaml 中除了 image 里的 ${VERSION}，不能出现其他 $ 符号");
  }

  let section = "";
  let currentService = "";
  let inBuildMap = false;
  const serviceBlocks = new Map();

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const noComment = stripComment(line);
    if (!noComment) continue;

    const indent = line.search(/\S/);
    const trimmed = noComment;
    if (indent === 0) {
      const topKey = trimmed.split(":")[0].trim();
      if (topKey !== "services" && topKey !== "volumes") {
        fail(`compose.yaml 顶层只允许 services 和 volumes，不允许 ${topKey}`);
      }
      section = topKey;
      currentService = "";
      inBuildMap = false;
      continue;
    }

    if (section === "services") {
      if (indent === 2 && trimmed.endsWith(":")) {
        currentService = trimmed.slice(0, -1).trim();
        inBuildMap = false;
        serviceBlocks.set(currentService, { image: "", context: "", dockerfile: "Dockerfile" });
        if (modId && !new RegExp(`^${modId}-[a-z0-9]+$`).test(currentService)) {
          fail(`compose.yaml 服务名 "${currentService}" 必须是 "${modId}-<小写字母或数字>"`);
        }
        continue;
      }
      if (currentService && indent === 4) {
        inBuildMap = false;
        const colon = trimmed.indexOf(":");
        if (colon === -1) continue;
        const key = trimmed.slice(0, colon).trim();
        const val = trimmed.slice(colon + 1).trim();
        if (FORBIDDEN_COMPOSE_KEYS.has(key) || !ALLOWED_COMPOSE_KEYS.has(key)) {
          fail(`compose.yaml 服务 ${currentService} 不允许字段 ${key}`);
        }
        const info = serviceBlocks.get(currentService);
        if (key === "image") {
          info.image = val.replace(/^["']|["']$/g, "");
          if (modId) {
            const expected = `vb-${currentService}:\${VERSION}`;
            if (info.image !== expected) {
              fail(`compose.yaml 服务 ${currentService} 的 image 必须是 ${expected}（当前为 ${info.image}）`);
            }
          }
        } else if (key === "build") {
          if (val === "") {
            inBuildMap = true;
          } else if (val.startsWith("{")) {
            const cm = val.match(/context\s*:\s*([^,}]+)/);
            const dm = val.match(/dockerfile\s*:\s*([^,}]+)/);
            if (cm) info.context = cm[1].trim().replace(/^["']|["']$/g, "");
            if (dm) info.dockerfile = dm[1].trim().replace(/^["']|["']$/g, "");
          } else {
            info.context = val.replace(/^["']|["']$/g, "");
          }
        }
      } else if (currentService && inBuildMap && indent >= 6) {
        const colon = trimmed.indexOf(":");
        if (colon === -1) continue;
        const key = trimmed.slice(0, colon).trim();
        const val = trimmed.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
        const info = serviceBlocks.get(currentService);
        if (key === "context") info.context = val;
        if (key === "dockerfile") info.dockerfile = val;
      } else if (currentService && indent >= 6 && trimmed.startsWith("-")) {
        // 粗检宿主机目录挂载
        const item = trimmed.slice(1).trim().replace(/^["']|["']$/g, "");
        if (/^(\.|\/|~)[a-zA-Z0-9_./-]*:/.test(item)) {
          fail(`compose.yaml 服务 ${currentService} 不能挂载宿主机路径：${item}`);
        }
      }
    }
  }

  for (const svc of declaredServices) {
    const fullName = `${modId}-${svc}`;
    if (modId && !serviceBlocks.has(fullName)) {
      fail(`module.yaml 声明了 ${svc}，但 compose.yaml 缺少服务 ${fullName}`);
    }
  }

  for (const [svcName, info] of serviceBlocks) {
    if (!info.image) fail(`compose.yaml 服务 ${svcName} 缺少 image`);
    if (!info.context) {
      fail(`compose.yaml 服务 ${svcName} 缺少 build 路径`);
      continue;
    }
    if (path.isAbsolute(info.context) || info.context.includes("..")) {
      fail(`compose.yaml 服务 ${svcName} 的 build.context 不能是绝对路径或包含 ..`);
      continue;
    }
    const ctxDir = path.resolve(root, info.context);
    const dfPath = path.resolve(ctxDir, info.dockerfile);
    if (!fs.existsSync(ctxDir)) {
      fail(`compose.yaml 服务 ${svcName} 的构建目录不存在：${info.context}`);
    } else if (!fs.existsSync(dfPath)) {
      fail(`compose.yaml 服务 ${svcName} 缺少 Dockerfile：${path.relative(root, dfPath)}`);
    } else {
      buildTargets.push({ svcName, dfPath });
    }
  }
}

// 3. 检查 Dockerfile 国内源 ARG 建议
for (const { svcName, dfPath } of buildTargets) {
  const df = fs.readFileSync(dfPath, "utf8");
  const rel = path.relative(root, dfPath);
  if (/\bgo\s+(mod|build)\b/.test(df) && !/^\s*ARG\s+GOPROXY\b/m.test(df)) {
    warn(`${svcName}（${rel}）使用了 Go，但未声明 ARG GOPROXY，国内服务器构建时可能下载依赖超时`);
  }
  if (/\b(npm|pnpm|yarn)\s+(ci|install)\b/.test(df) && !/^\s*ARG\s+NPM_REGISTRY\b/m.test(df)) {
    warn(`${svcName}（${rel}）使用了 npm/pnpm/yarn，但未声明 ARG NPM_REGISTRY，国内服务器构建时可能下载慢`);
  }
  if (/\bpip3?\s+install\b/.test(df) && !/^\s*ARG\s+PIP_INDEX_URL\b/m.test(df)) {
    warn(`${svcName}（${rel}）使用了 pip，但未声明 ARG PIP_INDEX_URL，国内服务器构建时可能下载慢`);
  }
}

// 3.5 检查前端源码中是否存在 401 触发 location.reload() 的死循环反模式
const feSrcDir = path.join(root, "frontend", "src");
if (fs.existsSync(feSrcDir) && fs.statSync(feSrcDir).isDirectory()) {
  const scanFrontend = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!IGNORE_DIRS.has(ent.name)) scanFrontend(full);
      } else if (ent.isFile() && /\.(ts|tsx|js|jsx|mjs|vue)$/.test(ent.name)) {
        const text = fs.readFileSync(full, "utf8");
        if (/status\s*===?\s*401[\s\S]{0,220}location\.reload\s*\(/.test(text)) {
          const rel = path.relative(root, full);
          fail(`${rel} 在处理 401 时调用了 location.reload()，公开浏览模式下会导致无限刷新死循环；请改为 location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search)`);
        }
      }
    }
  };
  scanFrontend(feSrcDir);
}

// 输出检查结果
for (const w of warnings) console.warn(`[提示] ${w}`);
for (const e of errors) console.error(`[错误] ${e}`);

if (errors.length > 0) {
  console.error(`\n自检未通过，共 ${errors.length} 处错误，请修复后重试。`);
  process.exit(1);
}

console.log(`自检通过：${modId} ${modVersion}（${warnings.length} 条提示）`);
if (checkOnly) process.exit(0);

// 4. 收集文件并打包为标准 ZIP（纯 JS 实现，跨平台零依赖）
const defaultOut = path.join(root, `${modId}-${modVersion}-source.zip`);
const zipOut = outPath ? path.resolve(outPath) : defaultOut;
const zipOutRel = path.relative(root, zipOut);

const entries = [];
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isSymbolicLink()) continue;
    const full = path.join(dir, ent.name);
    const rel = path.relative(root, full);
    if (ent.isDirectory()) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      walk(full);
    } else if (ent.isFile()) {
      if (IGNORE_FILES.has(ent.name)) continue;
      if (rel === zipOutRel || ent.name.endsWith("-source.zip")) continue;
      entries.push({ full, name: rel.split(path.sep).join("/") });
    }
  }
}
walk(root);

// ---- 最小标准 ZIP 写入器（Deflate + CRC32） ----
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

const zipBuf = createZip(entries);
fs.mkdirSync(path.dirname(zipOut), { recursive: true });
fs.writeFileSync(zipOut, zipBuf);
console.log(`已生成源码包：${zipOut}（${entries.length} 个文件，${(zipBuf.length / 1024).toFixed(1)} KB）`);

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const raw = fs.readFileSync(file.full);
    const stat = fs.statSync(file.full);
    const nameBuf = Buffer.from(file.name, "utf8");
    const crc = crc32(raw);
    const compressed = zlib.deflateRawSync(raw);
    const useDeflate = compressed.length < raw.length;
    const data = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const mode = (stat.mode & 0o777) || 0o644;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
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
