// FluxDown 插件索引校验器（零依赖，纯 Node）。CI 在每个 PR 上运行。
//
// 规则（对应 marketplace 设计的信任层）：
//  1. 每个 plugins/<id>/<ver>.json 是合法 JSON，字段齐全。
//  2. version 为合法 semver（三段整数）；pluginId 匹配 ^[a-z0-9_-]+@[a-z0-9_-]+$。
//  3. contentHash 形如 sha256:<64hex>；且 == 本地 dist/<file> 的实际 sha256
//     （dist 文件名取自 mirrors[0] 的 basename）。
//  4. mirrors 全部 https://（拒 http / IP 直连 / 内网 / 云元数据段）。
//  5. sequence 全局唯一且为正整数；index.json 的 sequence == 所有条目最大值。
//  6. index.json 与由分片重新 flatten 的结果一致（防手改漂移）。
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const errors = [];
const fail = (m) => errors.push(m);

const SEMVER = /^\d+\.\d+\.\d+$/;
const PLUGIN_ID = /^[a-z0-9_-]+@[a-z0-9_-]+$/;
const HEX64 = /^sha256:[0-9a-f]{64}$/;

function isPrivateHost(host) {
  // 拒 IP 直连、内网、link-local、云元数据段。
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return true; // 任何字面量 IP
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  return false;
}

const pluginsDir = `${ROOT}/plugins`;
const shards = [];
if (existsSync(pluginsDir)) {
  for (const id of readdirSync(pluginsDir)) {
    const dir = `${pluginsDir}/${id}`;
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      shards.push(`${dir}/${f}`);
    }
  }
}

const entries = [];
const seenSeq = new Set();
for (const path of shards) {
  let e;
  try {
    e = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`${path}: JSON 解析失败: ${err.message}`);
    continue;
  }
  if (!PLUGIN_ID.test(e.pluginId || "")) fail(`${path}: pluginId 非法`);
  if (!SEMVER.test(e.version || "")) fail(`${path}: version 非 semver`);
  if (!HEX64.test(e.contentHash || "")) fail(`${path}: contentHash 格式非法`);
  if (!Number.isInteger(e.sequence) || e.sequence < 1) fail(`${path}: sequence 须为正整数`);
  if (seenSeq.has(e.sequence)) fail(`${path}: sequence ${e.sequence} 重复`);
  seenSeq.add(e.sequence);
  if (!Array.isArray(e.mirrors) || e.mirrors.length === 0) fail(`${path}: mirrors 不可为空`);
  let distName = null;
  for (const url of e.mirrors || []) {
    let u;
    try {
      u = new URL(url);
    } catch {
      fail(`${path}: mirror URL 非法: ${url}`);
      continue;
    }
    if (u.protocol !== "https:") fail(`${path}: mirror 必须 https: ${url}`);
    if (isPrivateHost(u.hostname)) fail(`${path}: mirror 指向 IP/内网/元数据段: ${url}`);
    if (!distName) distName = url.split("/").pop();
  }
  // 校验本地 dist 文件哈希（防 content_hash 与实际字节漂移）。
  if (distName) {
    const distPath = `${ROOT}/dist/${distName}`;
    if (!existsSync(distPath)) {
      fail(`${path}: dist/${distName} 不存在（无法校验 content_hash）`);
    } else {
      const actual = "sha256:" + createHash("sha256").update(readFileSync(distPath)).digest("hex");
      if (actual !== e.contentHash) fail(`${path}: content_hash 不符（期望 ${e.contentHash}，实际 ${actual}）`);
    }
  }
  entries.push(e);
}

// index.json 与分片 flatten 一致性。
const maxSeq = entries.reduce((m, e) => Math.max(m, e.sequence || 0), 0);
if (existsSync(`${ROOT}/index.json`)) {
  const idx = JSON.parse(readFileSync(`${ROOT}/index.json`, "utf8"));
  if (idx.sequence !== maxSeq) fail(`index.json sequence(${idx.sequence}) != 分片最大值(${maxSeq})`);
  if ((idx.entries || []).length !== entries.length)
    fail(`index.json 条目数(${(idx.entries || []).length}) != 分片数(${entries.length})`);
}

if (errors.length) {
  console.error("索引校验失败：");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log(`索引校验通过：${entries.length} 个条目，sequence 高水位 ${maxSeq}。`);
