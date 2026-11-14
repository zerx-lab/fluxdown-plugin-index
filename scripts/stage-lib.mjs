// Stage: turn each registered author's GitHub Latest Release into an append-only shard.
// Pure over injected `github` / `download`, so tests run without network.
import { createHash } from "node:crypto";
import { isRegisteredRelease, generatedDocuments } from "./index-lib.mjs";
import { inspectPackage, compareVersions } from "./package-lib.mjs";
import { reviewOf } from "../vendor/fluxdown-plugin-manifest.mjs";
import { validatePublicationLocalizations } from "./publication-lib.mjs";

const sha256 = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");

/** Error that is not the publisher's fault (GitHub outage, throttling, network); retried next run. */
export class TransientError extends Error {
  constructor(message) {
    super(message);
    this.transient = true;
  }
}

export const shardPath = (pluginId, version) => `plugins/${pluginId}/${version}.json`;

export function publishedVersions(catalog, pluginId) {
  return [...catalog.shards.entries()].filter(([, entry]) => entry.pluginId === pluginId);
}

/** Next global sequence: above STATE, index.json and every shard (never reuses a gap). */
export function nextSequence(catalog) {
  return Math.max(catalog.state.sequence || 0, catalog.index?.sequence || 0,
    ...[...catalog.shards.values()].map((entry) => entry.sequence || 0)) + 1;
}

/**
 * Inspects one registered plugin's Latest Release.
 * Returns `{ status: "skipped" | "mirrored" | "published", version, path?, entry?, review }`;
 * throws (publisher-actionable) or TransientError. `catalog` is mutated only when `apply` is true.
 */
export async function stagePlugin({ plugin, catalog, github, download, apply = true }) {
  const release = await github.latestRelease(plugin.repo);
  if (!release) throw new Error(`仓库 ${plugin.repo} 不存在或没有 Latest Release（草稿与预发布不计）`);
  const assets = (release.assets || []).filter((asset) => asset.name.toLowerCase().endsWith(".fxplug"));
  if (assets.length !== 1) {
    throw new Error(`Latest Release ${release.tag_name} 须恰好包含 1 个 .fxplug 附件，实际 ${assets.length} 个`);
  }
  const [asset] = assets;
  const url = asset.browser_download_url;
  if (!isRegisteredRelease({ plugins: [plugin] }, plugin.id, url)) {
    throw new Error(`附件地址 ${url} 不属于登记仓库 ${plugin.repo} 的 Release`);
  }
  const published = publishedVersions(catalog, plugin.id);
  const sameUrl = published.find(([, entry]) => entry.mirrors.includes(url));
  if (sameUrl) {
    // GitHub digests every asset uploaded since 2025-06; a different digest means the bytes were swapped.
    if (asset.digest && asset.digest !== sameUrl[1].contentHash) {
      throw new Error(`已收录的 ${release.tag_name}/${asset.name} 被替换（digest ${asset.digest} ≠ ${sameUrl[1].contentHash}）。`
        + "已发布字节不可变：请恢复原附件，或提升版本号发布新 Release");
    }
    return { status: "skipped", version: sameUrl[1].version };
  }

  const bytes = await download(url);
  const contentHash = sha256(bytes);
  if (asset.digest && asset.digest !== contentHash) {
    throw new TransientError(`下载字节 ${contentHash} 与 GitHub digest ${asset.digest} 不一致`);
  }
  const { manifest } = inspectPackage(bytes);
  if (manifest.identity !== plugin.id) {
    throw new Error(`manifest identity ${manifest.identity} 与登记的 ${plugin.id} 不一致`);
  }
  const review = { ...reviewOf(manifest), tag: release.tag_name, asset: asset.name };

  const identical = published.find(([, entry]) => entry.contentHash === contentHash);
  if (identical) {
    // Same bytes ⇒ same manifest version: record the author's Release as one more verified mirror.
    const [path, entry] = identical;
    if (apply) catalog.shards.set(path, { ...entry, mirrors: [...entry.mirrors, url] });
    return { status: "mirrored", version: entry.version, path, review };
  }
  const latest = published.map(([, entry]) => entry.version).sort(compareVersions).pop();
  if (latest && compareVersions(manifest.version, latest) <= 0) {
    throw new Error(`manifest version ${manifest.version} 须高于已发布最高版本 ${latest}（同版本字节不可替换）`);
  }
  const publicationErrors = validatePublicationLocalizations(manifest);
  if (publicationErrors.length) throw new Error(publicationErrors.join("；"));

  const entry = {
    pluginId: plugin.id,
    version: manifest.version,
    sequence: nextSequence(catalog),
    contentHash,
    ...(manifest.minAppVersion ? { minAppVersion: manifest.minAppVersion } : {}),
    name: manifest.name,
    description: manifest.description ?? "",
    author: plugin.repo.split("/")[0],
    homepage: `https://github.com/${plugin.repo}`,
    mirrors: [url],
    publishTime: new Date(release.published_at).toISOString(),
    yanked: "none",
    tags: plugin.tags ?? [],
    permissions: review.permissions,
    networkHosts: review.networkHosts,
    sigScheme: "none",
    sigstoreBundleRef: "",
  };
  const path = shardPath(plugin.id, manifest.version);
  if (apply) catalog.shards.set(path, entry);
  return { status: "published", version: manifest.version, path, entry, review };
}

/** Stages every registered plugin in registry order; failures never block other plugins. */
export async function stageAll({ catalog, github, download, log = () => {} }) {
  const results = [];
  for (const plugin of catalog.registry.plugins) {
    try {
      const result = await stagePlugin({ plugin, catalog, github, download });
      log(`${plugin.id}: ${result.status} ${result.version}`);
      results.push({ plugin, ...result });
    } catch (err) {
      const status = err.transient ? "transient" : "failed";
      log(`${plugin.id}: ${status}: ${err.message}`);
      results.push({ plugin, status, error: err.message });
    }
  }
  return results;
}

export function writeCatalog(catalog, write) {
  const { state, index } = generatedDocuments(catalog);
  catalog.state = state;
  catalog.index = index;
  write("STATE", state);
  write("index.json", index);
}

/** Minimal GitHub REST client over fetch; 5xx / 429 / rate-limit / network are transient. */
export function githubClient(token, { fetchImpl = fetch } = {}) {
  async function api(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "fluxdown-plugin-index-stage",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new TransientError(`GitHub API ${method} ${path}: ${err.message}`);
    }
    if (method === "GET" && response.status === 404) return null;
    const text = await response.text();
    if (response.status >= 500 || response.status === 429
      || (response.status === 403 && /rate limit/i.test(text))) {
      throw new TransientError(`GitHub API ${method} ${path}: HTTP ${response.status}`);
    }
    if (!response.ok) throw new Error(`GitHub API ${method} ${path}: HTTP ${response.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  const encode = (repo) => repo.split("/").map(encodeURIComponent).join("/");
  return {
    api,
    latestRelease: (repo) => api("GET", `/repos/${encode(repo)}/releases/latest`),
  };
}

export const STAGE_FAIL_LABEL = "stage-fail";
const marker = (id) => `<!-- stage-fail:${id} -->`;

export function stageFailBody(plugin, error) {
  const owner = plugin.repo.split("/")[0];
  return [
    marker(plugin.id),
    `**插件 / Plugin**: \`${plugin.id}\` · [${plugin.repo}](https://github.com/${plugin.repo})`,
    "",
    "自动收录最新 Release 失败，修复后无需新 PR，下一轮 Stage（每小时）会自动重试并关闭本 issue。",
    "Staging the latest release failed. Fix it in your repository; the next hourly Stage run retries and closes this issue — no new PR needed.",
    "",
    "```",
    error,
    "```",
    "",
    `cc @${owner}`,
  ].join("\n");
}

/**
 * One open `stage-fail` issue per failing plugin, kept in sync with the latest error:
 * failures upsert, recovery closes, plugins removed from the registry close as delisted.
 * Transient results leave issues untouched.
 */
export async function syncStageIssues({ api, repo, results, registry }) {
  if (!await api("GET", `/repos/${repo}/labels/${STAGE_FAIL_LABEL}`)) {
    await api("POST", `/repos/${repo}/labels`, { name: STAGE_FAIL_LABEL, color: "d73a4a",
      description: "Stage could not ingest the registered plugin's latest release" });
  }
  const open = new Map();
  for (let page = 1; ; page++) {
    const issues = await api("GET", `/repos/${repo}/issues?state=open&labels=${STAGE_FAIL_LABEL}&per_page=100&page=${page}`);
    for (const issue of issues) {
      const id = /<!-- stage-fail:([a-z0-9_@-]+) -->/.exec(issue.body || "")?.[1];
      if (id && !issue.pull_request) open.set(id, issue);
    }
    if (issues.length < 100) break;
  }
  const close = async (issue, comment) => {
    await api("POST", `/repos/${repo}/issues/${issue.number}/comments`, { body: comment });
    await api("PATCH", `/repos/${repo}/issues/${issue.number}`, { state: "closed", state_reason: "completed" });
  };
  for (const result of results) {
    const issue = open.get(result.plugin.id);
    if (result.status === "failed") {
      const body = stageFailBody(result.plugin, result.error);
      if (!issue) {
        await api("POST", `/repos/${repo}/issues`, { title: `Stage failed: ${result.plugin.id}`, body, labels: [STAGE_FAIL_LABEL] });
      } else if (issue.body !== body) {
        await api("PATCH", `/repos/${repo}/issues/${issue.number}`, { body });
      }
    } else if (issue && result.status !== "transient") {
      await close(issue, `已恢复：当前收录版本 ${result.version}。\nResolved: version ${result.version} is staged.`);
    }
  }
  const registered = new Set(registry.plugins.map((plugin) => plugin.id));
  for (const [id, issue] of open) {
    if (!registered.has(id)) await close(issue, "已从 registry.json 移除，不再收录。\nRemoved from registry.json; no longer staged.");
  }
}
