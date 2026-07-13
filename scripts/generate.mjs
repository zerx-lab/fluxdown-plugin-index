// 由 plugins/**/*.json 分片 flatten 生成 index.json，并把 STATE.sequence 提升到高水位。
// CI 合并前运行（重新分配/复跑），或维护者本地运行后提交。
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const pluginsDir = `${ROOT}/plugins`;
const entries = [];
if (existsSync(pluginsDir)) {
  for (const id of readdirSync(pluginsDir)) {
    const dir = `${pluginsDir}/${id}`;
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".json")) entries.push(JSON.parse(readFileSync(`${dir}/${f}`, "utf8")));
    }
  }
}
entries.sort((a, b) => a.sequence - b.sequence);
const maxSeq = entries.reduce((m, e) => Math.max(m, e.sequence || 0), 0);
const state = existsSync(`${ROOT}/STATE`) ? JSON.parse(readFileSync(`${ROOT}/STATE`, "utf8")) : { indexId: crypto.randomUUID() };
const now = new Date().toISOString();
state.sequence = maxSeq;
state.updated = now;
writeFileSync(`${ROOT}/STATE`, JSON.stringify(state, null, 2) + "\n");
writeFileSync(
  `${ROOT}/index.json`,
  JSON.stringify({ indexId: state.indexId, sequence: maxSeq, updated: now, entries }, null, 2) + "\n",
);
console.log(`生成 index.json：${entries.length} 条目，sequence=${maxSeq}，indexId=${state.indexId}`);
