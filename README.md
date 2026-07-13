# FluxDown 插件索引（去中心化插件市场）

这不是一个网站，而是一份**可验证的数据格式**。FluxDown 用它发现、下载、校验插件。

## 设计要点（R4 去中心化 / R5 可追溯 / R6 永远可用）

- **联邦式 + 无许可退出权**：任何人可 fork 本仓库另立市场；哈希寻址使内容不依赖发布方信任。
- **内容寻址**：`contentHash = sha256(整个 .fxplug zip)` 是唯一真相源。客户端从任一镜像取回后
  一律以 `contentHash` 定案；哪条通道无所谓。
- **Git = Merkle DAG**：改写历史任何字节会级联改变后续 commit hash，被每个 clone/CDN 缓存独立见证。
- **多源分发**：`mirrors[]` 列出多条 https 通道（raw.githubusercontent / jsdelivr CDN / GitHub Release），
  任一存活即可安装。
- **防回滚**：全局 `sequence` 单调递增；客户端持久化 per-`indexId` 高水位，索引 sequence 回退即拒绝。

> **v1 签名说明**：作者级密码学签名（sigstore / ed25519）为后续增强，schema 已预留
> `sigScheme` / `sigstoreBundleRef` 字段（JSON，晚加不破坏兼容）。当前完整性基座 =
> 内容寻址（sha256）+ 传输层 TLS + Git 历史防篡改。

## 目录结构

```
STATE                                索引身份（indexId UUID）+ sequence 高水位
index.json                           flatten 后的全量目录（客户端拉取入口，CI 生成）
plugins/<pluginId>/<version>.json    每插件每版本一份分片（只增不删）
dist/<name>.fxplug                   插件包（= 插件目录的 zip：manifest.json + *.js）
scripts/validate.mjs                 CI 校验器（零依赖）
scripts/generate.mjs                 由分片重生成 index.json + STATE
.github/workflows/validate.yml       准入 CI
```

## 分片字段（`plugins/<id>/<ver>.json`）

| 字段 | 含义 |
|---|---|
| `pluginId` | `作者@名字`，`^[a-z0-9_-]+@[a-z0-9_-]+$` |
| `version` | semver 三段 |
| `sequence` | 全局单调递增整数（防回滚基线） |
| `contentHash` | `sha256:<hex>`，钉住 `.fxplug` 字节 |
| `minAppVersion` | 宿主版本门槛 |
| `mirrors[]` | 多条 https 下载 URL |
| `yanked` | `none`/`deprecated`/`vulnerable`/`malicious` |
| `sigScheme` / `sigstoreBundleRef` | 预留：作者签名（v1 为 `none`） |

## 发布一个插件（贡献流程）

1. 把插件目录（含 `manifest.json` + 入口 JS）打包为 `dist/<name>-<ver>.fxplug`（zip，根含 `manifest.json`）。
2. 新增 `plugins/<pluginId>/<ver>.json` 分片，`contentHash` 填 `sha256:$(sha256sum dist/<name>.fxplug)`，
   分配比当前最大值大 1 的 `sequence`。
3. 本地跑 `node scripts/generate.mjs` 重生成 `index.json` / `STATE`，一并提交。
4. 提 PR → CI（`validate.yml`）自动校验；通过后合并。
5. （可选）为该版本建一个 GitHub Release，把 `.fxplug` 作为 asset 上传，作为额外镜像。

## 客户端如何使用

FluxDown 引擎的 `plugin::market::MarketClient`：拉 `index.json`（多源 failover）→ 校验 sequence
不回退 → 多镜像择优下载 `.fxplug` → `contentHash` 钉住比对 → 复用安装管线
（zip-slip / 压缩炸弹防护 + manifest 校验）安装。
