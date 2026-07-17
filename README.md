<div align="center">

# FluxDown Plugin Index

**The plugin index for [FluxDown](https://fluxdown.zerx.dev) — a content-addressed, Git-versioned catalog of plugins.**

Not a website — a **verifiable data format**. FluxDown discovers, downloads, and verifies plugins directly from this Git repository.

[English](#english) · [简体中文](#简体中文)

</div>

---

## English

### What this is

This repository **is** the marketplace: a Git-versioned, content-addressed index that any FluxDown client fetches, verifies, and installs from. There is no backend, no account, and no gatekeeper API. You can fork it to host your own index.

### Design principles

| Principle | How it is realized |
|---|---|
| **No lock-in** | Anyone can fork this repo into an independent index. Content addressing means a plugin's bytes never depend on trusting the publisher. |
| **Content-addressed** | `contentHash = sha256(entire .fxplug zip)` is the single source of truth. A client accepts a download from *any* mirror as long as the hash matches — the channel is irrelevant. |
| **Tamper-evident history** | Git commit hashes chain over history, so rewriting any past byte is detectable by every clone and CDN cache. |
| **Multi-source delivery** | `mirrors[]` lists several HTTPS channels (raw.githubusercontent / jsDelivr CDN / GitHub Release). Any one alive is enough to install. |
| **Rollback protection** | A global monotonic `sequence`. Clients persist a per-`indexId` high-water mark and reject any index whose sequence regresses. |

> **Signing (v1 note).** Author-level cryptographic signatures (sigstore / ed25519) are a planned enhancement. The schema already reserves `sigScheme` / `sigstoreBundleRef` (JSON, additive, forward-compatible). The current integrity base is **content addressing (sha256) + transport TLS + Git history**.

### Repository layout

```
STATE                                Index identity (indexId UUID) + sequence high-water mark
index.json                           Flattened full catalog — the client fetch entry point (CI-generated)
plugins/<pluginId>/<version>.json    One shard per plugin per version (append-only)
dist/<name>-<version>.fxplug         Plugin package (a zip of the plugin dir: manifest.json + *.js)
scripts/validate.mjs                 CI validator (zero dependencies)
scripts/generate.mjs                 Regenerates index.json + STATE from shards (deterministic)
.github/workflows/validate.yml       Admission CI
```

### Shard fields (`plugins/<pluginId>/<version>.json`)

| Field | Required | Meaning |
|---|---|---|
| `pluginId` | ✓ | `author@name`, matching `^[a-z0-9_-]+@[a-z0-9_-]+$` (no `.`). |
| `version` | ✓ | Three-part semver `MAJOR.MINOR.PATCH`. |
| `sequence` | ✓ | Globally unique, monotonically increasing integer (rollback baseline). |
| `contentHash` | ✓ | `sha256:<64hex>`, pins the `.fxplug` bytes. |
| `mirrors[]` | ✓ | One or more HTTPS download URLs (no HTTP / IP-literal / intranet / metadata ranges). |
| `minAppVersion` | | Host version gate; compared as three-part semver at load. |
| `name` | | Display name (usually mirrors the manifest `name`). |
| `description` | | Short description shown in the market. |
| `author` | | Author / publisher handle. |
| `homepage` | | Project URL. |
| `publishTime` | | ISO 8601 publish timestamp. Also drives the deterministic `index.json` `updated` field. |
| `yanked` | | `none` (default) / `deprecated` / `vulnerable` / `malicious`. |
| `tags[]` | | Free-form discovery tags. |
| `permissions[]` | | Capability grants copied from the manifest (`ffmpeg` / `ytdlp`); shown to the user before install for authorization. |
| `sigScheme` / `sigstoreBundleRef` | | Reserved for author signatures (v1 is `none`). |

### The `.fxplug` package

A `.fxplug` is a plain zip of the plugin directory, **manifest.json at the root** (no top-level folder), alongside its entry scripts. Keep it deterministic (fixed timestamps, stored/deflated consistently) so `contentHash` is reproducible.

The FluxDown plugin runtime is a sandboxed QuickJS engine. What a plugin may declare in `manifest.json`:

| Manifest key | Purpose |
|---|---|
| `identity` / `name` / `version` | Identity `^[a-z0-9_-]+@[a-z0-9_-]+$`; three-part semver. |
| `description` / `homepage` / `icon` | Metadata; `icon` is a safe relative path. |
| `minAppVersion` | Minimum host version. |
| `resolvers[]` | At most one. `{ match: { urls: [...] }, entry, timeoutMs? }`. `urls` are glob patterns (`*` wildcard, prefix-anchored). Runs off-actor, lazily, before protocol routing; resolves a page to a direct link (optionally with quality `variants` for the user to pick at download time). |
| `hooks` | `{ entry, events, match? }`. `events` ⊆ `onStart` / `onError` / `onDone` / `onMetaProbed`. Fire-and-forget notifications; only `onError` may command a retry. |
| `settings[]` | Declarative settings, auto-rendered on desktop **and** web. Widget×type matrix: `text` / `password` / `textarea` / `folder` / `select` → `string`; `toggle` → `boolean`; `number` → `number`. A `string` field may carry a `helperScript` (copy-to-clipboard console snippet; the host never executes it). Values serialize as strings across ends. |
| `permissions[]` | Capability grants: `ffmpeg` (run the resolved ffmpeg/ffprobe on a produced file) and `ytdlp` (run the resolved yt-dlp in `resolve` or any hook). Unknown values reject the whole manifest — pair a new permission with a `minAppVersion` bump. |

Plugin-facing bridge APIs (always available unless noted): `flux.storage` (per-plugin key-value), `flux.log`, `flux.fs` (per-plugin scratch workspace), `flux.task.requestRetry` (in `onError`); and, gated by `permissions`, `flux.ffmpeg` / `flux.ffprobe` and `flux.ytdlp`. Full API reference: <https://fluxdown.zerx.dev/docs/en/plugins/api-reference/>.

### Publishing a plugin

1. Zip the plugin directory (with `manifest.json` at the root + entry JS) into `dist/<name>-<version>.fxplug`.
2. Add a shard `plugins/<pluginId>/<version>.json`. Set `contentHash` to `sha256:$(sha256sum dist/<name>-<version>.fxplug)` and assign a `sequence` one greater than the current maximum. Copy `permissions[]` from the manifest.
3. Run `node scripts/generate.mjs` to regenerate `index.json` / `STATE`, and commit them too.
4. Open a PR. CI (`validate.yml`) validates automatically; merge once green.
5. *(Optional)* Cut a GitHub Release for the version and attach the `.fxplug` as an asset — an extra mirror.

> `generate.mjs` is deterministic: `index.json.updated` is derived from the newest shard `publishTime`, not wall-clock time, so a regenerate-and-diff check in CI stays stable.

### How the client consumes it

FluxDown's `plugin::market::MarketClient`: fetch `index.json` (multi-source failover) → verify the sequence has not regressed → download the `.fxplug` from the best mirror → pin-compare against `contentHash` → install through the shared pipeline (zip-slip / zip-bomb protection + manifest validation).

---

## 简体中文

### 这是什么

本仓库**本身**就是市场：一份 Git 版本化、内容寻址的索引，任何 FluxDown 客户端都从这里发现、校验并安装插件。无后端、无账号、无准入 API。你也可以 fork 它自建索引。

### 设计要点

| 原则 | 实现方式 |
|---|---|
| **无锁定** | 任何人可 fork 本仓库另立索引；内容寻址使插件字节不依赖对发布方的信任。 |
| **内容寻址** | `contentHash = sha256(整个 .fxplug zip)` 是唯一真相源。客户端从**任一**镜像取回，只要哈希吻合即接受——走哪条通道无所谓。 |
| **可验证历史** | Git commit hash 沿历史链接，改写任何历史字节都会被每个 clone / CDN 缓存察觉。 |
| **多源分发** | `mirrors[]` 列出多条 HTTPS 通道（raw.githubusercontent / jsDelivr CDN / GitHub Release），任一存活即可安装。 |
| **防回滚** | 全局 `sequence` 单调递增；客户端持久化 per-`indexId` 高水位，索引 sequence 回退即拒绝。 |

> **v1 签名说明。** 作者级密码学签名（sigstore / ed25519）为后续增强。schema 已预留 `sigScheme` / `sigstoreBundleRef`（JSON，追加式、前向兼容）。当前完整性基座 = **内容寻址（sha256）+ 传输层 TLS + Git 历史防篡改**。

### 目录结构

```
STATE                                索引身份（indexId UUID）+ sequence 高水位
index.json                           flatten 后的全量目录 —— 客户端拉取入口（CI 生成）
plugins/<pluginId>/<version>.json    每插件每版本一份分片（只增不删）
dist/<name>-<version>.fxplug         插件包（= 插件目录的 zip：manifest.json + *.js）
scripts/validate.mjs                 CI 校验器（零依赖）
scripts/generate.mjs                 由分片重生成 index.json + STATE（确定性）
.github/workflows/validate.yml       准入 CI
```

### 分片字段（`plugins/<pluginId>/<version>.json`）

| 字段 | 必填 | 含义 |
|---|---|---|
| `pluginId` | ✓ | `作者@名字`，匹配 `^[a-z0-9_-]+@[a-z0-9_-]+$`（禁 `.`）。 |
| `version` | ✓ | 三段 semver `MAJOR.MINOR.PATCH`。 |
| `sequence` | ✓ | 全局唯一、单调递增整数（防回滚基线）。 |
| `contentHash` | ✓ | `sha256:<64hex>`，钉住 `.fxplug` 字节。 |
| `mirrors[]` | ✓ | 一条或多条 HTTPS 下载 URL（拒 HTTP / IP 直连 / 内网 / 元数据段）。 |
| `minAppVersion` | | 宿主版本门槛；加载时按三段 semver 比较。 |
| `name` | | 展示名（通常同 manifest 的 `name`）。 |
| `description` | | 市场展示的简短描述。 |
| `author` | | 作者 / 发布方标识。 |
| `homepage` | | 项目地址。 |
| `publishTime` | | ISO 8601 发布时间；同时决定 `index.json` 的确定性 `updated` 字段。 |
| `yanked` | | `none`（默认）/ `deprecated` / `vulnerable` / `malicious`。 |
| `tags[]` | | 自由发现标签。 |
| `permissions[]` | | 从 manifest 抄录的能力授权（`ffmpeg` / `ytdlp`）；安装前展示给用户确认。 |
| `sigScheme` / `sigstoreBundleRef` | | 预留：作者签名（v1 为 `none`）。 |

### `.fxplug` 插件包

`.fxplug` 是插件目录的普通 zip，**manifest.json 位于根目录**（无顶层文件夹），与入口脚本并列。请保持确定性打包（固定时间戳、压缩方式一致），使 `contentHash` 可复现。

FluxDown 插件运行时是沙箱化的 QuickJS 引擎。插件可在 `manifest.json` 声明：

| Manifest 字段 | 用途 |
|---|---|
| `identity` / `name` / `version` | 标识 `^[a-z0-9_-]+@[a-z0-9_-]+$`；三段 semver。 |
| `description` / `homepage` / `icon` | 元数据；`icon` 为安全相对路径。 |
| `minAppVersion` | 最低宿主版本。 |
| `resolvers[]` | 至多一个。`{ match: { urls: [...] }, entry, timeoutMs? }`。`urls` 为 glob（`*` 通配、前缀锚定）。off-actor 惰性执行、在协议路由前把页面解析为直链（可附画质 `variants`，供用户下载时选择）。 |
| `hooks` | `{ entry, events, match? }`。`events` ⊆ `onStart` / `onError` / `onDone` / `onMetaProbed`。fire-and-forget 通知；仅 `onError` 可命令式重试。 |
| `settings[]` | 声明式设置项，双端（桌面 + web）自动渲染表单。widget×type 矩阵：`text` / `password` / `textarea` / `folder` / `select` → `string`；`toggle` → `boolean`；`number` → `number`。`string` 字段可带 `helperScript`（复制到剪贴板的 Console 脚本，宿主绝不执行）。值跨端一律字符串序列化。 |
| `permissions[]` | 能力授权：`ffmpeg`（对产物文件运行解析到的 ffmpeg/ffprobe）与 `ytdlp`（在 `resolve` 或任意 hook 运行解析到的 yt-dlp）。未知值会拒绝整份 manifest —— 新增权限时请一并抬高 `minAppVersion`。 |

插件侧桥接 API（除注明外始终可用）：`flux.storage`（每插件键值存储）、`flux.log`、`flux.fs`（每插件临时工作区）、`flux.task.requestRetry`（`onError` 内）；以及经 `permissions` 门控的 `flux.ffmpeg` / `flux.ffprobe` 与 `flux.ytdlp`。完整 API 参考：<https://fluxdown.zerx.dev/docs/zh/plugins/api-reference/>。

### 发布一个插件

1. 把插件目录（含 `manifest.json` 于根目录 + 入口 JS）打包为 `dist/<name>-<version>.fxplug`。
2. 新增分片 `plugins/<pluginId>/<version>.json`：`contentHash` 填 `sha256:$(sha256sum dist/<name>-<version>.fxplug)`，`sequence` 取当前最大值 +1，`permissions[]` 从 manifest 抄录。
3. 跑 `node scripts/generate.mjs` 重生成 `index.json` / `STATE`，一并提交。
4. 提 PR → CI（`validate.yml`）自动校验；通过后合并。
5. *（可选）* 为该版本建一个 GitHub Release，把 `.fxplug` 作为 asset 上传，作为额外镜像。

> `generate.mjs` 是确定性的：`index.json.updated` 取自最新分片的 `publishTime` 而非运行时钟，因此 CI 的「重生成后 diff」检查恒稳。

### 客户端如何使用

FluxDown 引擎的 `plugin::market::MarketClient`：拉 `index.json`（多源 failover）→ 校验 sequence 不回退 → 从最优镜像下载 `.fxplug` → 用 `contentHash` 钉住比对 → 复用安装管线（zip-slip / 压缩炸弹防护 + manifest 校验）安装。
