// Zero-dependency .fxplug reader + manifest admission.
// Mirrors FluxDown native/engine/src/plugin/{install,manifest}.rs: a package admitted
// here must install on the client. Listing rules may be stricter (strict three-part
// version, entry/icon files must exist), never looser.
import { isIP } from "node:net";
import { inflateRawSync } from "node:zlib";

export const MAX_ENTRIES = 200;
export const MAX_TOTAL_UNCOMPRESSED = 50 * 1024 * 1024;
export const VALID_EVENTS = ["onStart", "onError", "onDone", "onMetaProbed", "onCancel"];
export const VALID_PERMISSIONS = ["ffmpeg", "ytdlp", "auth", "tasks", "browserRules", "desktop", "background",
  "intercept", "pageScripts"];
export const STAGE_NAMES = ["prepare", "probed", "refresh", "selectVariant", "selectPeriod", "segments",
  "liveSegments", "finalize", "failed"];
const VIEW_LOCATIONS = ["activity", "settings", "taskDetail", "window"];
const RUN_AT = ["document_start", "document_end", "document_idle"];
const WORLDS = ["isolated", "main"];
const WINDOW_SIZE_MIN = 240;
const WINDOW_SIZE_MAX = 4096;
const NETWORK_HOSTS_MAX = 64;
const VIEWS_MAX = 16;
const COMMANDS_MAX = 32;
const TITLE_MAX_CHARS = 40;
const SNIFF_PACK_MAX_BYTES = 256 * 1024;
const SNIFF_PACK_MAX_RULES = 500;
const PAGE_SCRIPTS_MAX = 16;
const PAGE_SCRIPT_MATCHES_MAX = 32;
const PAGE_SCRIPT_JS_MAX = 8;
const PAGE_SCRIPT_FILE_MAX_BYTES = 256 * 1024;
const PAGE_SCRIPT_MAX_BYTES = 384 * 1024;
const RSS_PROVIDER_ID = "rss";
const IDENTITY = /^[a-z0-9_-]+@[a-z0-9_-]+$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Three-part semver comparison; both sides must already match SEMVER. */
export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

export const isVersion = (value) => typeof value === "string" && SEMVER.test(value);

/** Same rule as engine `is_safe_relative_path`. */
export function isSafeRelativePath(path) {
  if (typeof path !== "string" || !path) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  if (path.split(/[/\\]/).some((segment) => !segment || segment === "." || segment === "..")) return false;
  return !/[\u0000-\u001f\u007f-\u009f]/.test(path);
}

function findEndOfCentralDirectory(bytes) {
  const lowest = Math.max(0, bytes.length - 0xffff - 22);
  for (let i = bytes.length - 22; i >= lowest; i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("不是有效 zip：缺少中央目录结尾");
}

/**
 * Reads every file of a .fxplug into memory with the client's install limits.
 * Returns `Map<relativePath, Buffer>` rooted at the directory holding manifest.json
 * (a single wrapper directory is stripped, as the client does).
 */
export function readPackage(bytes) {
  const eocd = findEndOfCentralDirectory(bytes);
  const count = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) throw new Error("不支持 ZIP64 插件包");
  if (count > MAX_ENTRIES) throw new Error(`zip 条目数 ${count} 超过上限 ${MAX_ENTRIES}`);
  if (directoryOffset + directorySize > eocd) throw new Error("zip 中央目录越界");

  const raw = new Map();
  let total = 0;
  let cursor = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("zip 中央目录条目损坏");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;

    if (flags & 1) throw new Error(`${name}: 不允许加密条目`);
    if ((mode & 0o170000) === 0o120000) throw new Error(`${name}: 不允许符号链接`);
    if (name.includes("\\")) throw new Error(`${name}: zip 路径分隔符必须为 /`);
    const isDirectory = name.endsWith("/");
    const path = isDirectory ? name.slice(0, -1) : name;
    if (!isSafeRelativePath(path)) throw new Error(`${name}: zip 含非法路径（zip-slip）`);
    if (isDirectory) continue;
    if (raw.has(path)) throw new Error(`${name}: zip 条目重复`);

    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`${name}: 本地文件头损坏`);
    const dataStart = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    if (data.length !== compressedSize) throw new Error(`${name}: 条目数据越界`);
    const remaining = MAX_TOTAL_UNCOMPRESSED - total;
    let content;
    if (method === 0) content = Buffer.from(data);
    else if (method === 8) {
      try {
        content = inflateRawSync(data, { maxOutputLength: remaining + 1 });
      } catch (err) {
        if (err instanceof RangeError || err.code === "ERR_BUFFER_TOO_LARGE") {
          throw new Error(`解压总量超过 ${MAX_TOTAL_UNCOMPRESSED} 字节上限（疑压缩炸弹）`);
        }
        throw new Error(`${name}: 解压失败: ${err.message}`);
      }
    } else throw new Error(`${name}: 不支持的压缩方式 ${method}（仅 stored/deflate）`);
    total += content.length;
    if (total > MAX_TOTAL_UNCOMPRESSED) throw new Error(`解压总量超过 ${MAX_TOTAL_UNCOMPRESSED} 字节上限（疑压缩炸弹）`);
    if (content.length !== size || crc32(content) !== crc) throw new Error(`${name}: CRC/长度校验失败`);
    raw.set(path, content);
  }

  if (raw.has("manifest.json")) return raw;
  const tops = new Set([...raw.keys()].map((path) => path.split("/")[0]));
  const [top] = tops;
  if (tops.size === 1 && raw.has(`${top}/manifest.json`)) {
    return new Map([...raw].map(([path, content]) => [path.slice(top.length + 1), content]));
  }
  throw new Error("zip 内未找到根 manifest.json");
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const positiveTimeout = (value) => value === undefined || value === null || (Number.isSafeInteger(value) && value > 0);

function unknownKeys(errors, where, value, allowed) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${where}: 未知字段 ${key}`);
}

function checkEntry(errors, where, entry, files) {
  if (!isSafeRelativePath(entry)) errors.push(`${where} 路径 '${entry}' 非法`);
  else if (!files.has(entry.replaceAll("\\", "/"))) errors.push(`${where} 指向的 ${entry} 不在包内`);
}

function checkMatch(errors, where, match) {
  if (!isObject(match)) return errors.push(`${where} 须为对象`);
  unknownKeys(errors, where, match, ["urls"]);
  if (!Array.isArray(match.urls) || !match.urls.length || !match.urls.every(nonEmptyString)) {
    errors.push(`${where}.urls 须为非空字符串数组`);
  }
}

function checkSetting(errors, field, seen) {
  if (!isObject(field)) return errors.push("settings 条目须为对象");
  const key = field.key;
  const where = `setting '${key}'`;
  unknownKeys(errors, where, field, ["key", "title", "description", "type", "widget", "options", "default",
    "required", "min", "max", "pattern", "helperScript", "helperLabel"]);
  if (!nonEmptyString(key)) errors.push("setting key 不可为空");
  else if (seen.has(key)) errors.push(`setting key '${key}' 重复`);
  seen.add(key);
  if (typeof field.title !== "string") errors.push(`${where}: title 必填`);
  const type = field.type;
  if (!["string", "number", "boolean"].includes(type)) return errors.push(`${where}: type 非法`);
  const widget = field.widget ?? { string: "text", number: "number", boolean: "toggle" }[type];
  const allowed = { text: "string", password: "string", textarea: "string", folder: "string", select: "string",
    toggle: "boolean", number: "number" };
  if (allowed[widget] !== type) errors.push(`${where}: widget '${widget}' 不允许 type '${type}'`);
  const options = field.options ?? [];
  if (!Array.isArray(options) || !options.every((o) => isObject(o) && typeof o.value === "string" && typeof o.label === "string")) {
    errors.push(`${where}: options 须为 {value,label} 字符串数组`);
  }
  const fallback = field.default;
  if (fallback !== undefined && fallback !== null && typeof fallback !== "string") errors.push(`${where}: default 须为字符串`);
  if (widget === "select") {
    if (!options.length) errors.push(`${where}: select 的 options 不可为空`);
    else if (typeof fallback === "string" && !options.some((o) => o.value === fallback)) {
      errors.push(`${where}: default '${fallback}' 不在 options 中`);
    }
  }
  for (const bound of ["min", "max"]) {
    const value = field[bound];
    if (value === undefined || value === null) continue;
    if (type !== "number") errors.push(`${where}: min/max 仅 number 有效`);
    else if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${where}: ${bound} 非有限数`);
  }
  if (typeof field.min === "number" && typeof field.max === "number" && field.min > field.max) {
    errors.push(`${where}: min(${field.min}) > max(${field.max})`);
  }
  if (field.pattern != null && type !== "string") errors.push(`${where}: pattern 仅 string 有效`);
  if (field.helperScript != null) {
    if (type !== "string") errors.push(`${where}: helperScript 仅 string 有效`);
    if (typeof field.helperScript !== "string" || !field.helperScript || Buffer.byteLength(field.helperScript) > 4096) {
      errors.push(`${where}: helperScript 须非空且 ≤4KB`);
    }
  }
  if (field.helperLabel != null && (typeof field.helperLabel !== "string" || [...field.helperLabel].length > 60
    || field.helperScript == null)) {
    errors.push(`${where}: helperLabel 须 ≤60 字符且须与 helperScript 同时出现`);
  }
  if (type === "number" && typeof fallback === "string") {
    const value = Number(fallback);
    if (fallback.trim() === "" || !Number.isFinite(value)) errors.push(`${where}: number default '${fallback}' 非法`);
    else if ((typeof field.min === "number" && value < field.min) || (typeof field.max === "number" && value > field.max)) {
      errors.push(`${where}: default ${value} 超出 min/max`);
    }
  }
  if (type === "boolean" && typeof fallback === "string" && fallback !== "true" && fallback !== "false") {
    errors.push(`${where}: boolean default 必须为 'true'/'false'`);
  }
}

const chars = (value) => [...value].length;
const hasExtension = (path, exts) => exts.some((ext) => path.toLowerCase().endsWith(ext));
const contributionId = (id) => typeof id === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(id);
const pageScriptId = (id) => typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(id);
const validTitle = (title) => typeof title === "string" && chars(title) >= 1 && chars(title) <= TITLE_MAX_CHARS;

/** Mirrors engine `is_valid_match_pattern`. */
function isValidMatchPattern(pattern) {
  if (typeof pattern !== "string") return false;
  const split = pattern.indexOf("://");
  if (split < 0) return false;
  const scheme = pattern.slice(0, split);
  const rest = pattern.slice(split + 3);
  if (!["http", "https", "*"].includes(scheme)) return false;
  const slash = rest.indexOf("/");
  if (slash < 0) return false;
  const host = rest.slice(0, slash);
  if (/[\u0000-\u001f\u007f-\u009f\s]/.test(rest.slice(slash))) return false;
  const domain = host.startsWith("*.") ? host.slice(2) : host;
  return domain !== "" && domain.includes(".") && /^[a-z0-9.-]+$/.test(domain)
    && !/^[.-]/.test(domain) && !/[.-]$/.test(domain) && !domain.includes("..");
}

/** Mirrors engine `is_valid_network_host`. */
function isValidNetworkHost(host) {
  if (typeof host !== "string" || !host || Buffer.byteLength(host) > 253) return false;
  if (!host.includes("%") && isIP(host)) return host === host.toLowerCase();
  return host.split(".").every((label) => label !== "" && label.length <= 63 && /^[a-z0-9-]+$/.test(label)
    && !label.startsWith("-") && !label.endsWith("-"));
}

function checkInterceptors(errors, interceptors, permissions, files) {
  if (!isObject(interceptors)) return errors.push("interceptors 须为对象");
  unknownKeys(errors, "interceptors", interceptors, ["entry", "stages", "match", "timeoutMs", "onFailure"]);
  checkEntry(errors, "interceptors entry", interceptors.entry, files);
  if (!Array.isArray(interceptors.stages) || !interceptors.stages.length) errors.push("interceptors.stages 不可为空");
  else {
    const seen = new Set();
    for (const stage of interceptors.stages) {
      if (!STAGE_NAMES.includes(stage)) errors.push(`未知拦截阶段 '${stage}'，合法：${STAGE_NAMES.join(", ")}`);
      else if (seen.has(stage)) errors.push(`interceptors.stages 重复：'${stage}'`);
      seen.add(stage);
    }
  }
  if (!isObject(interceptors.match)) errors.push("interceptors match 须为对象");
  else {
    unknownKeys(errors, "interceptors match", interceptors.match, ["urls"]);
    if (!Array.isArray(interceptors.match.urls) || !interceptors.match.urls.length
      || !interceptors.match.urls.every((u) => typeof u === "string")) errors.push("interceptors match.urls 不可为空");
  }
  if (!positiveTimeout(interceptors.timeoutMs)) errors.push("interceptors timeoutMs 须为正整数");
  if (interceptors.onFailure != null && !["continue", "fail"].includes(interceptors.onFailure)) {
    errors.push(`interceptors onFailure '${interceptors.onFailure}' 非法，合法：continue, fail`);
  }
  if (!permissions.includes("intercept")) errors.push("声明 interceptors 时 permissions 必须包含 intercept");
}

function checkMain(errors, main, permissions, files) {
  if (!isObject(main)) return errors.push("main 须为对象");
  unknownKeys(errors, "main", main, ["entry", "events", "background"]);
  checkEntry(errors, "main entry", main.entry, files);
  if (typeof main.entry === "string" && !hasExtension(main.entry, [".js"])) errors.push(`main entry '${main.entry}' 扩展名须为 .js`);
  if (main.events != null) {
    if (!Array.isArray(main.events)) errors.push("main.events 须为数组");
    else for (const event of main.events) {
      if (!VALID_EVENTS.includes(event)) errors.push(`main.events 未知事件 '${event}'，合法：${VALID_EVENTS.join(", ")}`);
    }
  }
  if (main.background != null && typeof main.background !== "boolean") errors.push("main.background 须为布尔");
  if (main.background === true && !permissions.includes("background")) {
    errors.push("main.background 为 true 时 permissions 必须包含 background");
  }
}

function checkDesktop(errors, view, desktop, permissions, files) {
  const where = `view '${view.id}'`;
  if (!isObject(desktop)) return errors.push(`${where} desktop 须为对象`);
  unknownKeys(errors, `${where} desktop`, desktop, ["entry", "networkHosts", "width", "height"]);
  checkEntry(errors, `${where} desktop entry`, desktop.entry, files);
  if (typeof desktop.entry === "string" && !hasExtension(desktop.entry, [".js", ".mjs"])) {
    errors.push(`${where} desktop entry '${desktop.entry}' 扩展名须为 .js 或 .mjs`);
  }
  if (!permissions.includes("desktop")) errors.push(`${where} 声明 desktop 时 permissions 必须包含 desktop`);
  for (const name of ["width", "height"]) {
    const size = desktop[name];
    if (size == null) continue;
    if (view.location !== "window") errors.push(`${where} 的 ${name} 仅允许用于 location 为 window 的 view`);
    else if (typeof size !== "number" || !Number.isFinite(size) || size < WINDOW_SIZE_MIN || size > WINDOW_SIZE_MAX) {
      errors.push(`${where} ${name} 须为 [${WINDOW_SIZE_MIN}, ${WINDOW_SIZE_MAX}] 内的有限数`);
    }
  }
  const hosts = desktop.networkHosts ?? [];
  if (!Array.isArray(hosts)) return errors.push(`${where} networkHosts 须为数组`);
  if (hosts.length > NETWORK_HOSTS_MAX) errors.push(`${where} networkHosts 至多 ${NETWORK_HOSTS_MAX} 项`);
  const seen = new Set();
  for (const host of hosts) {
    if (!isValidNetworkHost(host)) errors.push(`${where} networkHosts '${host}' 非法`);
    else if (seen.has(host)) errors.push(`${where} networkHosts '${host}' 重复`);
    seen.add(host);
  }
}

function checkPageScripts(errors, scripts, permissions, files) {
  if (!scripts.length) return;
  if (scripts.length > PAGE_SCRIPTS_MAX) errors.push(`contributes.pageScripts 至多 ${PAGE_SCRIPTS_MAX} 项`);
  if (!permissions.includes("pageScripts")) errors.push("声明 pageScripts 时 permissions 必须包含 pageScripts");
  const seen = new Set();
  for (const script of scripts) {
    if (!isObject(script)) {
      errors.push("pageScript 须为对象");
      continue;
    }
    const where = `pageScript '${script.id}'`;
    unknownKeys(errors, where, script, ["id", "title", "matches", "excludeMatches", "js", "runAt", "world", "allFrames"]);
    if (!pageScriptId(script.id)) errors.push(`pageScript id '${script.id}' 非法：须匹配 ^[a-z0-9][a-z0-9_-]{0,31}$`);
    else if (seen.has(script.id)) errors.push(`${where} 重复`);
    seen.add(script.id);
    if (!validTitle(script.title)) errors.push(`${where} title 须为 1–${TITLE_MAX_CHARS} 个字符`);
    const matches = script.matches;
    if (!Array.isArray(matches) || matches.length < 1 || matches.length > PAGE_SCRIPT_MATCHES_MAX) {
      errors.push(`${where} matches 须为 1–${PAGE_SCRIPT_MATCHES_MAX} 项`);
    }
    const excludes = script.excludeMatches ?? [];
    if (!Array.isArray(excludes)) errors.push(`${where} excludeMatches 须为数组`);
    else if (excludes.length > PAGE_SCRIPT_MATCHES_MAX) errors.push(`${where} excludeMatches 至多 ${PAGE_SCRIPT_MATCHES_MAX} 项`);
    for (const [field, list] of [["matches", matches], ["excludeMatches", excludes]]) {
      if (Array.isArray(list)) for (const pattern of list) {
        if (!isValidMatchPattern(pattern)) errors.push(`${where} ${field} '${pattern}' 非法 match pattern`);
      }
    }
    if (script.runAt != null && !RUN_AT.includes(script.runAt)) errors.push(`${where} runAt '${script.runAt}' 非法`);
    if (script.world != null && !WORLDS.includes(script.world)) errors.push(`${where} world '${script.world}' 非法`);
    if (script.allFrames != null && typeof script.allFrames !== "boolean") errors.push(`${where} allFrames 须为布尔`);
    const js = script.js;
    if (!Array.isArray(js) || js.length < 1 || js.length > PAGE_SCRIPT_JS_MAX) {
      errors.push(`${where} js 须为 1–${PAGE_SCRIPT_JS_MAX} 项`);
      continue;
    }
    const used = new Set();
    let code = 0;
    for (const [index, file] of js.entries()) {
      if (!isSafeRelativePath(file)) {
        errors.push(`${where} js 路径 '${file}' 非法`);
        continue;
      }
      if (!hasExtension(file, [".js"])) errors.push(`${where} js '${file}' 扩展名须为 .js`);
      if (used.has(file)) errors.push(`${where} js '${file}' 重复`);
      used.add(file);
      const content = files.get(file.replaceAll("\\", "/"));
      if (!content) {
        errors.push(`${where} js 指向的 ${file} 不在包内`);
        continue;
      }
      if (content.length > PAGE_SCRIPT_FILE_MAX_BYTES) errors.push(`${where} 文件 '${file}' 超过 ${PAGE_SCRIPT_FILE_MAX_BYTES} 字节`);
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(content);
      } catch {
        errors.push(`${where} 文件 '${file}' 不是合法 UTF-8`);
      }
      code += content.length + (index > 0 ? 3 : 0);
    }
    if (code > PAGE_SCRIPT_MAX_BYTES) errors.push(`${where} 拼接后超过 ${PAGE_SCRIPT_MAX_BYTES} 字节`);
  }
}

function checkSniffRules(errors, rules, permissions, files) {
  if (typeof rules !== "string" || !isSafeRelativePath(rules)) return errors.push(`sniffRules 路径 '${rules}' 非法`);
  if (!hasExtension(rules, [".json"])) errors.push(`sniffRules '${rules}' 扩展名须为 .json`);
  if (!permissions.includes("browserRules")) errors.push("声明 sniffRules 时 permissions 必须包含 browserRules");
  const content = files.get(rules.replaceAll("\\", "/"));
  if (!content) return errors.push(`sniffRules 指向的 ${rules} 不在包内`);
  if (content.length > SNIFF_PACK_MAX_BYTES) return errors.push(`sniffRules 文件超过 ${SNIFF_PACK_MAX_BYTES} 字节`);
  let pack;
  try {
    pack = JSON.parse(content.toString("utf8"));
  } catch (err) {
    return errors.push(`sniffRules JSON 解析失败: ${err.message}`);
  }
  if (pack?.format !== "fluxdown-sniff-pack") errors.push("sniffRules format 须为 fluxdown-sniff-pack");
  else if (!Array.isArray(pack.rules)) errors.push("sniffRules rules 须为数组");
  else if (pack.rules.length > SNIFF_PACK_MAX_RULES) errors.push(`sniffRules 至多 ${SNIFF_PACK_MAX_RULES} 条规则`);
}

function checkContributes(errors, manifest, permissions, files) {
  const contributes = manifest.contributes;
  if (!isObject(contributes)) return errors.push("contributes 须为对象");
  unknownKeys(errors, "contributes", contributes, ["views", "commands", "sniffRules", "pageScripts"]);
  const views = contributes.views ?? [];
  const commands = contributes.commands ?? [];
  const pageScripts = contributes.pageScripts ?? [];
  if (!Array.isArray(views)) errors.push("contributes.views 须为数组");
  if (!Array.isArray(commands)) errors.push("contributes.commands 须为数组");
  if (!Array.isArray(pageScripts)) errors.push("contributes.pageScripts 须为数组");
  if (!Array.isArray(views) || !Array.isArray(commands) || !Array.isArray(pageScripts)) return;

  if (views.length > VIEWS_MAX) errors.push(`contributes.views 至多 ${VIEWS_MAX} 项`);
  const seenViews = new Set();
  let settingsViews = 0;
  for (const view of views) {
    if (!isObject(view)) {
      errors.push("view 须为对象");
      continue;
    }
    unknownKeys(errors, `view '${view.id}'`, view, ["id", "title", "location", "desktop", "portable"]);
    if (!contributionId(view.id)) errors.push(`view id '${view.id}' 非法：须匹配 ^[a-z][a-z0-9-]{0,31}$`);
    else if (seenViews.has(view.id)) errors.push(`view id '${view.id}' 重复`);
    seenViews.add(view.id);
    if (!validTitle(view.title)) errors.push(`view '${view.id}' title 须为 1–${TITLE_MAX_CHARS} 个字符`);
    if (!VIEW_LOCATIONS.includes(view.location)) errors.push(`view '${view.id}' location '${view.location}' 非法`);
    if (view.location === "settings" && ++settingsViews > 1) errors.push("location 为 settings 的 view 至多 1 个");
    if (view.portable != null && typeof view.portable !== "boolean") errors.push(`view '${view.id}' portable 须为布尔`);
    if (view.desktop == null) {
      if (view.portable === true) errors.push(`view '${view.id}' 的 portable 仅允许与 desktop 同时声明`);
    } else checkDesktop(errors, view, view.desktop, permissions, files);
    if ((view.desktop == null || view.portable === true) && manifest.main == null) {
      errors.push(`view '${view.id}' 有可移植实现，必须声明 main`);
    }
  }

  if (commands.length > COMMANDS_MAX) errors.push(`contributes.commands 至多 ${COMMANDS_MAX} 项`);
  const seenCommands = new Set();
  for (const command of commands) {
    if (!isObject(command)) {
      errors.push("command 须为对象");
      continue;
    }
    unknownKeys(errors, `command '${command.id}'`, command, ["id", "title", "palette", "taskMenu"]);
    if (!contributionId(command.id)) errors.push(`command id '${command.id}' 非法：须匹配 ^[a-z][a-z0-9-]{0,31}$`);
    else if (seenCommands.has(command.id)) errors.push(`command id '${command.id}' 重复`);
    seenCommands.add(command.id);
    if (!validTitle(command.title)) errors.push(`command '${command.id}' title 须为 1–${TITLE_MAX_CHARS} 个字符`);
    for (const flag of ["palette", "taskMenu"]) {
      if (command[flag] != null && typeof command[flag] !== "boolean") errors.push(`command '${command.id}' ${flag} 须为布尔`);
    }
  }
  if (commands.length && manifest.main == null) errors.push("声明 commands 时必须声明 main");
  if (contributes.sniffRules != null) checkSniffRules(errors, contributes.sniffRules, permissions, files);
  checkPageScripts(errors, pageScripts, permissions, files);
}

/** Validates manifest.json against the engine schema; returns a list of errors. */
export function validateManifest(manifest, files) {
  const errors = [];
  if (!isObject(manifest)) return ["manifest.json 须为 JSON 对象"];
  unknownKeys(errors, "manifest", manifest, ["identity", "name", "version", "description", "homepage", "icon",
    "minAppVersion", "resolvers", "subscriptions", "hooks", "interceptors", "auth", "main", "contributes",
    "settings", "permissions"]);
  if (!IDENTITY.test(manifest.identity ?? "")) errors.push(`identity '${manifest.identity}' 非法：须匹配 ${IDENTITY}`);
  if (!nonEmptyString(manifest.name)) errors.push("name 不可为空");
  if (!isVersion(manifest.version)) errors.push(`version '${manifest.version}' 须为三段 MAJOR.MINOR.PATCH（市场不收预发布/v 前缀）`);
  for (const key of ["description", "homepage", "icon", "minAppVersion"]) {
    if (manifest[key] !== undefined && typeof manifest[key] !== "string") errors.push(`${key} 须为字符串`);
  }
  if (manifest.minAppVersion && !isVersion(manifest.minAppVersion)) errors.push(`minAppVersion '${manifest.minAppVersion}' 非法`);
  if (manifest.icon) checkEntry(errors, "icon", manifest.icon, files);

  const resolvers = manifest.resolvers ?? [];
  if (!Array.isArray(resolvers)) errors.push("resolvers 须为数组");
  else {
    if (resolvers.length > 1) errors.push("v1 每插件至多一个 resolver");
    for (const resolver of resolvers) {
      if (!isObject(resolver)) {
        errors.push("resolver 须为对象");
        continue;
      }
      unknownKeys(errors, "resolver", resolver, ["match", "entry", "timeoutMs", "multi"]);
      checkMatch(errors, "resolver match", resolver.match);
      checkEntry(errors, "resolver entry", resolver.entry, files);
      if (!positiveTimeout(resolver.timeoutMs)) errors.push("resolver timeoutMs 须为正整数");
      if (resolver.multi !== undefined && typeof resolver.multi !== "boolean") errors.push("resolver multi 须为布尔");
    }
  }

  const subscriptions = manifest.subscriptions ?? [];
  if (!Array.isArray(subscriptions)) errors.push("subscriptions 须为数组");
  else {
    if (subscriptions.length > 1) errors.push("v1 每插件至多一个 subscription provider");
    for (const subscription of subscriptions) {
      if (!isObject(subscription)) {
        errors.push("subscription 须为对象");
        continue;
      }
      unknownKeys(errors, "subscription", subscription, ["providerId", "entry", "timeoutMs"]);
      const id = subscription.providerId;
      if (typeof id !== "string" || !/^[a-z0-9_-]{1,64}$/.test(id)) errors.push(`subscription providerId '${id}' 非法`);
      else if (id === RSS_PROVIDER_ID) errors.push(`subscription providerId '${id}' 为内置 provider 保留字`);
      checkEntry(errors, "subscription entry", subscription.entry, files);
      if (!positiveTimeout(subscription.timeoutMs)) errors.push("subscription timeoutMs 须为正整数");
    }
  }

  const permissions = manifest.permissions ?? [];
  if (!Array.isArray(permissions) || !permissions.every((p) => typeof p === "string")) errors.push("permissions 须为字符串数组");
  else for (const permission of permissions) {
    if (!VALID_PERMISSIONS.includes(permission)) errors.push(`未知权限 '${permission}'，合法：${VALID_PERMISSIONS.join(", ")}`);
  }

  if (manifest.hooks != null) {
    const hooks = manifest.hooks;
    if (!isObject(hooks)) errors.push("hooks 须为对象");
    else {
      unknownKeys(errors, "hooks", hooks, ["entry", "events", "match"]);
      checkEntry(errors, "hooks entry", hooks.entry, files);
      if (!Array.isArray(hooks.events) || !hooks.events.length) errors.push("hooks.events 不可为空");
      else for (const event of hooks.events) {
        if (!VALID_EVENTS.includes(event)) errors.push(`未知事件 '${event}'，合法：${VALID_EVENTS.join(", ")}`);
      }
      if (hooks.match != null) checkMatch(errors, "hooks match", hooks.match);
    }
  }

  if (manifest.auth != null) {
    const auth = manifest.auth;
    if (!isObject(auth)) errors.push("auth 须为对象");
    else {
      unknownKeys(errors, "auth", auth, ["entry", "timeoutMs"]);
      checkEntry(errors, "auth entry", auth.entry, files);
      if (!Array.isArray(permissions) || !permissions.includes("auth")) errors.push("声明 auth.entry 时 permissions 必须包含 auth");
      if (!positiveTimeout(auth.timeoutMs)) errors.push("auth timeoutMs 须为正整数");
    }
  }

  const granted = Array.isArray(permissions) ? permissions : [];
  if (manifest.interceptors != null) checkInterceptors(errors, manifest.interceptors, granted, files);
  if (manifest.main != null) checkMain(errors, manifest.main, granted, files);
  if (manifest.contributes != null) checkContributes(errors, manifest, granted, files);

  const settings = manifest.settings ?? [];
  if (!Array.isArray(settings)) errors.push("settings 须为数组");
  else {
    const seen = new Set();
    for (const field of settings) checkSetting(errors, field, seen);
  }
  return errors;
}

/** URL patterns the plugin can intercept (resolver + hooks + interceptors + page scripts); reviewers and comments show them. */
export function matchPatterns(manifest) {
  const scripts = isObject(manifest.contributes) && Array.isArray(manifest.contributes.pageScripts)
    ? manifest.contributes.pageScripts : [];
  return [...new Set([...(manifest.resolvers ?? []).flatMap((r) => r?.match?.urls ?? []),
    ...(manifest.hooks?.match?.urls ?? []), ...(manifest.interceptors?.match?.urls ?? []),
    ...scripts.flatMap((s) => [...(s?.matches ?? [])])])].sort();
}

/** Parses + validates a .fxplug; throws with every admission error joined. */
export function inspectPackage(bytes) {
  const files = readPackage(bytes);
  let manifest;
  try {
    manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  } catch (err) {
    throw new Error(`manifest.json 解析失败: ${err.message}`);
  }
  const errors = validateManifest(manifest, files);
  if (errors.length) throw new Error(errors.join("；"));
  return { manifest, files };
}
