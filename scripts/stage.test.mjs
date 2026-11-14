import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { generatedDocuments, validateCatalog } from "./index-lib.mjs";
import { crc32, readPackage, inspectPackage } from "./package-lib.mjs";
import { stagePlugin, stageAll, syncStageIssues, stageFailBody, TransientError } from "./stage-lib.mjs";
import { checkRegistry } from "./check-registry.mjs";
import { checkMirrors } from "./check-mirrors.mjs";
import { validatePublicationLocalizations } from "./publication-lib.mjs";

const ID = "252c2b9e-c113-42d2-b1b5-3bf8bdb01866";
const REPO = "alice/fluxdown-plugin-demo";
const PLUGIN = { id: "alice@demo", repo: REPO, tags: ["video"] };
const digest = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");

/** Minimal zip writer; `deflate` exercises the inflate path, `mode` the external attributes. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, content = "", deflate = false, mode = 0o100644 } of entries) {
    const data = Buffer.from(content);
    const stored = deflate ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, stored);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const manifest = (overrides = {}) => ({
  identity: "alice@demo", name: "Demo", version: "1.1.0", description: "demo plugin",
  resolvers: [{ match: { urls: ["*://video.example.com/*"] }, entry: "resolver.js" }],
  permissions: ["ffmpeg"], ...overrides,
});
const fxplug = (m = manifest(), extra = []) => zip([
  { name: "manifest.json", content: JSON.stringify(m), deflate: true },
  { name: "resolver.js", content: "globalThis.resolve = () => null;" },
  ...extra,
]);

function catalogWith(shards = [], plugins = [PLUGIN]) {
  const catalog = {
    shards: new Map(shards.map((entry) => [`plugins/${entry.pluginId}/${entry.version}.json`, entry])),
    payloads: new Map(),
    state: { indexId: ID, sequence: Math.max(0, ...shards.map((e) => e.sequence)), updated: "2026-09-30T00:00:00.000Z" },
    registry: { plugins },
  };
  catalog.index = generatedDocuments(catalog).index;
  catalog.state = generatedDocuments(catalog).state;
  return catalog;
}

const releaseUrl = (tag, asset = "demo.fxplug") => `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
function fakes(bytes, { tag = "v1.1.0", assetDigest = digest(bytes), assets } = {}) {
  const downloads = [];
  return {
    downloads,
    github: {
      latestRelease: async () => ({
        tag_name: tag, published_at: "2026-10-01T08:00:00Z",
        assets: assets ?? [{ name: "demo.fxplug", browser_download_url: releaseUrl(tag), digest: assetDigest }],
      }),
    },
    download: async (url) => {
      downloads.push(url);
      return bytes;
    },
  };
}

const legacyShard = (version, bytes, sequence) => ({
  pluginId: "alice@demo", version, sequence, contentHash: digest(bytes), name: "Demo", author: "alice",
  mirrors: [`https://raw.githubusercontent.com/zerx-lab/fluxdown-plugin-index/${"a".repeat(40)}/dist/demo-${version}.fxplug`],
  publishTime: "2026-09-01T00:00:00.000Z", yanked: "none",
});

test("a new release becomes the next-sequence shard with manifest permissions and the verified release mirror", async () => {
  const old = fxplug(manifest({ version: "1.0.0" }));
  const catalog = catalogWith([legacyShard("1.0.0", old, 7)]);
  catalog.state.sequence = 9; // STATE high-water above every shard still wins.
  const bytes = fxplug();
  const result = await stagePlugin({ plugin: PLUGIN, catalog, ...fakes(bytes) });
  assert.equal(result.status, "published");
  assert.deepEqual(result.entry, {
    pluginId: "alice@demo", version: "1.1.0", sequence: 10, contentHash: digest(bytes), name: "Demo",
    description: "demo plugin", author: "alice", homepage: `https://github.com/${REPO}`, mirrors: [releaseUrl("v1.1.0")],
    publishTime: "2026-10-01T08:00:00.000Z", yanked: "none", tags: ["video"], permissions: ["ffmpeg"], networkHosts: [],
    sigScheme: "none", sigstoreBundleRef: "",
  });
  assert.deepEqual(result.review.downloadUrls, ["*://video.example.com/*"]);
  const { state, index } = generatedDocuments(catalog);
  Object.assign(catalog, { state, index });
  // The legacy shard has no dist payload in this fixture; only the registered-release shard may skip dist/.
  const errors = validateCatalog(catalog);
  assert.deepEqual(errors.filter((e) => e.includes("1.1.0")), []);
  assert.ok(errors.some((e) => e.includes("1.0.0") && e.includes("dist/")), errors.join("\n"));
});

test("a staged release asset is not downloaded again, but a swapped asset is reported", async () => {
  const bytes = fxplug();
  const catalog = catalogWith([{ ...legacyShard("1.1.0", bytes, 3), mirrors: [releaseUrl("v1.1.0")] }]);
  const same = fakes(bytes);
  assert.equal((await stagePlugin({ plugin: PLUGIN, catalog, ...same })).status, "skipped");
  assert.deepEqual(same.downloads, []);
  const swapped = fakes(bytes, { assetDigest: digest(Buffer.from("other bytes")) });
  await assert.rejects(stagePlugin({ plugin: PLUGIN, catalog, ...swapped }), /被替换/);
});

test("identical bytes already published elsewhere only gain the author's release as a mirror", async () => {
  const bytes = fxplug();
  const catalog = catalogWith([legacyShard("1.1.0", bytes, 3)]);
  const result = await stagePlugin({ plugin: PLUGIN, catalog, ...fakes(bytes) });
  assert.equal(result.status, "mirrored");
  const entry = catalog.shards.get("plugins/alice@demo/1.1.0.json");
  assert.equal(entry.sequence, 3);
  assert.equal(entry.mirrors.at(-1), releaseUrl("v1.1.0"));
  assert.equal(catalog.shards.size, 1);
});

const legacySetting = { key: "quality", title: "Quality", type: "string", widget: "select",
  description: "Choose quality", options: [{ value: "best", label: "Best" }],
  helperScript: "copy(document.cookie)", helperLabel: "Copy script" };
const localizedSetting = () => ({
  ...legacySetting,
  localizations: Object.fromEntries(["en", "zh"].map((locale) => [locale, {
    title: `${locale} quality`, description: `${locale} description`,
    helperLabel: `${locale} copy`, options: { best: `${locale} best` },
  }])),
});

test("market publication requires complete baseline text, not just a localization declaration", () => {
  assert.deepEqual(validatePublicationLocalizations(manifest()), []);
  const valid = localizedSetting();
  assert.deepEqual(validatePublicationLocalizations(manifest({ settings: [valid] })), []);
  for (const locale of ["en", "zh"]) {
    for (const key of ["title", "description", "helperLabel", "options"]) {
      const field = localizedSetting();
      field.localizations[locale][key] = key === "options" ? { best: " \n" } : " \n";
      const errors = validatePublicationLocalizations(manifest({ settings: [field] }));
      assert.ok(errors.some((error) => error.includes(`localizations.${locale}.${key}`)), errors.join("\n"));
    }
  }
  const empty = { ...legacySetting, localizations: { en: {}, zh: {} } };
  assert.equal(validatePublicationLocalizations(manifest({ settings: [empty] })).length, 8);
  const noCustomHelp = localizedSetting();
  delete noCustomHelp.description;
  delete noCustomHelp.helperLabel;
  for (const text of Object.values(noCustomHelp.localizations)) {
    delete text.description;
    delete text.helperLabel;
  }
  assert.deepEqual(validatePublicationLocalizations(manifest({ settings: [noCustomHelp] })), []);
});

test("old installable settings stay installable and mirrored, but first publication and updates are rejected", async () => {
  const bytes = fxplug(manifest({ settings: [legacySetting] }));
  assert.equal(inspectPackage(bytes).manifest.settings[0].key, "quality");
  for (const shards of [[], [legacyShard("1.0.0", Buffer.from("old"), 3)]]) {
    const catalog = catalogWith(shards);
    const before = structuredClone(catalog);
    await assert.rejects(stagePlugin({ plugin: PLUGIN, catalog, ...fakes(bytes) }), /localizations\.en\.title/);
    assert.deepEqual(catalog, before);
  }
  const published = { ...legacyShard("1.1.0", bytes, 3), mirrors: [releaseUrl("v1.1.0")] };
  const existing = catalogWith([published]);
  assert.equal((await stagePlugin({ plugin: PLUGIN, catalog: existing, ...fakes(bytes) })).status, "skipped");
  const mirrored = await stagePlugin({ plugin: PLUGIN, catalog: existing, ...fakes(bytes, { tag: "mirror" }) });
  assert.equal(mirrored.status, "mirrored");
  assert.equal(existing.shards.get(mirrored.path).sequence, 3);
  const registry = await checkRegistry({
    catalog: catalogWith([], []), head: { plugins: [PLUGIN] }, ...fakes(bytes),
  });
  assert.equal(registry.ok, false);
  assert.match(registry.markdown, /localizations\.zh\.title/);
});

test("mirror CI checks new raw shards against the trusted baseline without re-admitting old settings", async () => {
  const bytes = fxplug(manifest({ settings: [legacySetting] }));
  const published = { ...legacyShard("1.1.0", bytes, 3), mirrors: [releaseUrl("v1.1.0")] };
  const catalog = catalogWith([published]);
  const download = async () => bytes;
  const log = () => {};
  const historical = await checkMirrors(catalog, { baseline: structuredClone(catalog), download, log });
  assert.deepEqual(historical.errors, []);
  const firstPublication = await checkMirrors(catalog, { baseline: catalogWith([]), download, log });
  assert.ok(firstPublication.errors.some((error) => error.includes("localizations.en.title")));
  const sameHashDifferentVersion = catalogWith([{ ...published, version: "1.0.0" }]);
  const renamed = await checkMirrors(catalog, { baseline: sameHashDifferentVersion, download, log });
  assert.ok(renamed.errors.some((error) => error.includes("localizations.en.title")));
  const yanked = catalogWith([{ ...published, yanked: "deprecated" }]);
  const bypass = await checkMirrors(yanked, { baseline: catalogWith([]), download, log });
  assert.ok(bypass.errors.some((error) => error.includes("localizations.en.title")));
});

test("identity, version regression and asset count are publisher errors", async () => {
  const catalog = catalogWith([legacyShard("1.1.0", Buffer.from("published"), 3)]);
  await assert.rejects(stagePlugin({ plugin: PLUGIN, catalog, ...fakes(fxplug(manifest({ identity: "mallory@demo" }))) }),
    /identity mallory@demo 与登记的 alice@demo 不一致/);
  await assert.rejects(stagePlugin({ plugin: PLUGIN, catalog, ...fakes(fxplug()) }), /须高于已发布最高版本 1\.1\.0/);
  await assert.rejects(stagePlugin({ plugin: PLUGIN, catalog, ...fakes(fxplug(), { assets: [] }) }), /恰好包含 1 个 \.fxplug/);
  const foreign = [{ name: "demo.fxplug", browser_download_url: "https://github.com/mallory/x/releases/download/v1/demo.fxplug" }];
  await assert.rejects(stagePlugin({ plugin: PLUGIN, catalog, ...fakes(fxplug(), { assets: foreign }) }), /不属于登记仓库/);
});

test("one failing or throttled plugin never blocks the others", async () => {
  const other = { id: "bob@tool", repo: "bob/tool" };
  const catalog = catalogWith([], [other, PLUGIN]);
  const bytes = fxplug();
  const { download } = fakes(bytes);
  const github = {
    latestRelease: async (repo) => {
      if (repo === "bob/tool") throw new TransientError("GitHub API GET: HTTP 503");
      return (await fakes(bytes).github.latestRelease());
    },
  };
  const results = await stageAll({ catalog, github, download });
  assert.deepEqual(results.map((r) => [r.plugin.id, r.status]), [["bob@tool", "transient"], ["alice@demo", "published"]]);
});

test("package admission matches the client's install rules", () => {
  assert.throws(() => readPackage(zip([{ name: "../evil.js" }, { name: "manifest.json", content: "{}" }])), /zip-slip/);
  assert.throws(() => readPackage(zip([{ name: "link", mode: 0o120777 }, { name: "manifest.json", content: "{}" }])), /符号链接/);
  const wrapped = readPackage(zip([{ name: "demo/manifest.json", content: "{}" }, { name: "demo/resolver.js" }]));
  assert.deepEqual([...wrapped.keys()].sort(), ["manifest.json", "resolver.js"]);
  assert.throws(() => readPackage(zip([{ name: "a/manifest.json", content: "{}" }, { name: "b/x.js" }])), /根 manifest\.json/);
  assert.throws(() => inspectPackage(fxplug(manifest({ permissions: ["shell"] }))), /未知权限 'shell'/);
  assert.throws(() => inspectPackage(fxplug(manifest({ auth: { entry: "resolver.js" } }))), /permissions 必须包含 auth/);
  assert.throws(() => inspectPackage(fxplug(manifest({ hooks: { entry: "missing.js", events: ["onDone"] } }))), /不在包内/);
  assert.throws(() => inspectPackage(fxplug(manifest({ version: "v1.1.0" }))), /三段/);
  assert.throws(() => inspectPackage(fxplug(manifest({ extra: true }))), /未知字段 extra/);
  assert.throws(() => inspectPackage(fxplug(manifest({ settings: [{ key: "q", title: "Q", type: "boolean", widget: "text" }] }))),
    /widget 'text' 不允许 type 'boolean'/);
  assert.equal(inspectPackage(fxplug()).manifest.identity, "alice@demo");
});

test("new manifest rules are enforced and desktop network hosts are staged with the risk level", async () => {
  const view = { id: "w", title: "W", location: "window", desktop: { entry: "w.js", networkHosts: ["b.example.com", "a.example.com"] } };
  const desktop = manifest({ permissions: ["desktop"], contributes: { views: [view] } });
  const bytes = fxplug(desktop, [{ name: "w.js", content: "export default 1;" }]);
  const result = await stagePlugin({ plugin: PLUGIN, catalog: catalogWith([]), ...fakes(bytes) });
  assert.deepEqual(result.entry.networkHosts, ["a.example.com", "b.example.com"]);
  assert.equal(result.review.risk, "full");
  assert.throws(() => inspectPackage(fxplug(manifest({ contributes: { views: [view] } }), [{ name: "w.js" }])), /permissions 必须包含 desktop/);
  assert.throws(() => inspectPackage(fxplug(manifest({ permissions: ["browserRules"], contributes: { sniffRules: "rules.json" } }),
    [{ name: "rules.json", content: '{"format":"nope","rules":[]}' }])), /sniffRules format/);
  assert.throws(() => inspectPackage(fxplug(manifest({ window: { entry: "w.js" } }), [{ name: "w.js" }])), /未知字段 window/);
});

test("catalog validation checks shard permissions and networkHosts", () => {
  const shard = legacyShard("1.0.0", Buffer.from("x"), 1);
  const ok = (extra) => validateCatalog(catalogWith([{ ...shard, ...extra }]), { checkIndex: false });
  assert.deepEqual(ok({ permissions: ["desktop"], networkHosts: ["a.example.com"] }).filter((e) => /permissions|networkHosts/.test(e)), []);
  assert.ok(ok({ permissions: ["root"] }).some((e) => e.includes("permissions")));
  assert.ok(ok({ networkHosts: "a.example.com" }).some((e) => e.includes("networkHosts")));
  assert.ok(ok({ networkHosts: Array(65).fill("a.example.com") }).some((e) => e.includes("networkHosts")));
});

test("registry rejects duplicate identities and repositories", () => {
  const catalog = catalogWith([], [PLUGIN, { id: "alice@demo", repo: "alice/other" }, { id: "alice@x", repo: REPO.toUpperCase() }]);
  const errors = validateCatalog(catalog);
  assert.ok(errors.some((e) => e.includes("id alice@demo 重复登记")), errors.join("\n"));
  assert.ok(errors.some((e) => e.includes("已登记其他插件")), errors.join("\n"));
});

test("a release mirror of an unregistered repository still needs a local dist payload", () => {
  const shard = { ...legacyShard("1.0.0", Buffer.from("x"), 1), mirrors: [releaseUrl("v1.0.0")] };
  assert.deepEqual(validateCatalog(catalogWith([shard])), []);
  const errors = validateCatalog(catalogWith([shard], []));
  assert.ok(errors.some((e) => e.includes("dist/demo.fxplug 不存在")), errors.join("\n"));
});

function fakeApi(openIssues = []) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push([method, path, body]);
    if (method === "GET" && path.includes("/labels/")) return { name: "stage-fail" };
    if (method === "GET" && path.includes("/issues?")) return openIssues;
    return {};
  };
  return { api, calls, writes: () => calls.filter(([method]) => method !== "GET") };
}

test("stage-fail issues are upserted on failure, closed on recovery or delisting, untouched on transient errors", async () => {
  const registry = { plugins: [PLUGIN, { id: "bob@tool", repo: "bob/tool" }] };
  const created = fakeApi();
  await syncStageIssues({ api: created.api, repo: "o/r", registry,
    results: [{ plugin: PLUGIN, status: "failed", error: "no release" }, { plugin: registry.plugins[1], status: "transient" }] });
  assert.deepEqual(created.writes().map(([m, p, b]) => [m, p, b.title]), [["POST", "/repos/o/r/issues", "Stage failed: alice@demo"]]);

  const body = stageFailBody(PLUGIN, "no release");
  const unchanged = fakeApi([{ number: 5, body }]);
  await syncStageIssues({ api: unchanged.api, repo: "o/r", registry, results: [{ plugin: PLUGIN, status: "failed", error: "no release" }] });
  assert.deepEqual(unchanged.writes(), []);

  const recovered = fakeApi([{ number: 5, body }, { number: 6, body: stageFailBody({ id: "gone@x", repo: "g/x" }, "e") }]);
  await syncStageIssues({ api: recovered.api, repo: "o/r", registry,
    results: [{ plugin: PLUGIN, status: "published", version: "1.1.0" }, { plugin: registry.plugins[1], status: "transient" }] });
  assert.deepEqual(recovered.writes().filter(([m]) => m === "PATCH").map(([, p]) => p),
    ["/repos/o/r/issues/5", "/repos/o/r/issues/6"]);
});

test("registry PR check dry-runs new entries without mutating the catalog and flags foreign history", async () => {
  const catalog = catalogWith([{ ...legacyShard("1.0.0", Buffer.from("x"), 1), author: "mallory" }], []);
  const { github, download } = fakes(fxplug());
  const { ok, markdown } = await checkRegistry({ catalog, head: { plugins: [PLUGIN] }, github, download });
  assert.equal(ok, true, markdown);
  assert.match(markdown, /将作为新版本收录/);
  assert.match(markdown, /其他作者发布的历史版本/);
  assert.match(markdown, /`ffmpeg`/);
  assert.equal(catalog.shards.size, 1);

  const bad = await checkRegistry({ catalog, head: { plugins: [{ ...PLUGIN, id: "Bad" }] }, github, download });
  assert.equal(bad.ok, false);
});

test("formerIds rename an identity: old shards stay valid, new releases stage under the new id, the PR check flags it", async () => {
  const OLD = { id: "alice@old", repo: REPO };
  const renamed = { ...PLUGIN, formerIds: [OLD.id] };
  const oldShard = { ...legacyShard("1.1.0", Buffer.from("old identity"), 3), pluginId: OLD.id, mirrors: [releaseUrl("v1.1.0")] };

  const delisted = catalogWith([oldShard], [PLUGIN]);
  assert.ok(validateCatalog(delisted).some((e) => e.includes(OLD.id) && e.includes("dist/")));

  const catalog = catalogWith([oldShard], [renamed]);
  assert.deepEqual(validateCatalog(catalog), []);
  // The old id's 1.1.0 does not block the new id's first release, even at the same version.
  const result = await stagePlugin({ plugin: renamed, catalog, ...fakes(fxplug()) });
  assert.equal(result.status, "published");
  assert.equal(result.entry.pluginId, PLUGIN.id);

  const { github, download } = fakes(fxplug());
  const { ok, markdown } = await checkRegistry({ catalog: catalogWith([oldShard], [OLD]), head: { plugins: [renamed] }, github, download });
  assert.equal(ok, true, markdown);
  assert.match(markdown, /新增 formerIds `alice@old`/);
  assert.doesNotMatch(markdown, /delisted/);
});
