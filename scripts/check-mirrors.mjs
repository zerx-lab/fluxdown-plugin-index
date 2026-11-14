// Optional online admission, deliberately separate from offline programming checks.
import { get } from "node:https";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { loadCatalog, loadBaseline, validateCatalog, mirrorURL, safeMirror, MAX_PACKAGE_BYTES } from "./index-lib.mjs";
import { inspectPackage } from "./package-lib.mjs";
import { isPublishedPackage, validatePublicationLocalizations } from "./publication-lib.mjs";

const TIMEOUT_MS = 45_000;
const MAX_REDIRECTS = 5;

/** Full guarded GET (HTTPS/public hosts on every hop, ≤5 redirects, ≤10 MiB, 45 s total). */
export async function mirrorBytes(value) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("mirror GET 超过 45 秒总超时")), TIMEOUT_MS);
  try {
    let url = mirrorURL(value);
    for (let redirects = 0; ; redirects++) {
      const response = await new Promise((resolveResponse, reject) => {
        const request = get(url, {
          signal: controller.signal,
          headers: { Accept: "application/octet-stream", "Accept-Encoding": "identity" },
        }, resolveResponse);
        // Network errors and the total-deadline abort are not the publisher's fault; Stage retries next run.
        request.once("error", (err) => reject(Object.assign(err, { transient: true })));
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        if (redirects >= MAX_REDIRECTS) throw new Error("mirror 超过 5 次重定向上限");
        if (!response.headers.location) throw new Error("mirror 重定向缺少 Location");
        url = mirrorURL(new URL(response.headers.location, url).href);
        continue;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        const err = new Error(`mirror 完整 GET 返回 HTTP ${response.statusCode}（须为 200）`);
        err.transient = response.statusCode >= 500 || response.statusCode === 429;
        throw err;
      }
      const declared = response.headers["content-length"];
      if (declared !== undefined && Number(declared) > MAX_PACKAGE_BYTES) {
        response.destroy();
        throw new Error("mirror 插件包超过 10 MiB 上限");
      }
      const chunks = [];
      let size = 0;
      // A body stream error is a network failure (transient); the size limit below is not.
      response.once("error", (err) => Object.assign(err, { transient: true }));
      for await (const chunk of response) {
        size += chunk.length;
        if (size > MAX_PACKAGE_BYTES) {
          response.destroy();
          throw new Error("mirror 插件包超过 10 MiB 上限");
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function mirrorHash(value) {
  return "sha256:" + createHash("sha256").update(await mirrorBytes(value)).digest("hex");
}

/** Verify every mirror; with a trusted baseline, enforce policy only on unpublished packages. */
export async function checkMirrors(catalog, { baseline, download = mirrorBytes, log = console.log } = {}) {
  const errors = [];
  let count = 0;
  for (const [path, entry] of catalog.shards) {
    const newPublication = baseline !== undefined && !isPublishedPackage(entry, baseline);
    // New yanked entries still need admission: otherwise publishing yanked and then
    // unyanking on the next change could bypass the publication policy.
    if ((entry.yanked ?? "none") !== "none" && !newPublication) {
      log(`跳过已撤回版本: ${path}（yanked: ${entry.yanked}）`);
      continue;
    }
    let publicationChecked = !newPublication;
    for (const value of entry.mirrors) {
      count++;
      try {
        const bytes = await download(value);
        const actual = "sha256:" + createHash("sha256").update(bytes).digest("hex");
        if (actual !== entry.contentHash) throw new Error(`哈希不符（期望 ${entry.contentHash}，实际 ${actual}）`);
        if (!publicationChecked) {
          publicationChecked = true;
          const { manifest } = inspectPackage(bytes);
          const admissionErrors = validatePublicationLocalizations(manifest);
          if (admissionErrors.length) throw new Error(admissionErrors.join("；"));
        }
        log(`GET/hash 通过: ${path}: ${safeMirror(value)}`);
      } catch (err) {
        errors.push(`${path}: ${safeMirror(value)}: ${err.message}`);
      }
    }
  }
  return { errors, count };
}

async function main() {
  const args = process.argv.slice(2);
  let root = fileURLToPath(new URL("..", import.meta.url));
  let base;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && args[i + 1]) root = resolve(args[++i]);
    else if (args[i] === "--base" && args[i + 1]) base = resolve(args[++i]);
    else throw new Error("用法: node scripts/check-mirrors.mjs [--root <目录>] [--base <完整基线 checkout>]");
  }
  const catalog = loadCatalog(root);
  const offlineErrors = validateCatalog(catalog);
  if (offlineErrors.length) throw new Error("本地索引无效：\n  - " + offlineErrors.join("\n  - "));
  const { errors, count } = await checkMirrors(catalog, {
    baseline: base === undefined ? undefined : loadBaseline(base, catalog),
  });
  if (errors.length) throw new Error("远端镜像校验失败：\n  - " + errors.join("\n  - "));
  console.log(`远端镜像校验通过：${count} 个完整 HTTPS GET/hash（每包 ≤10 MiB）。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
