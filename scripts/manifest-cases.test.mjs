// Runs the engine's shared manifest fixture (FluxDown native/engine/src/plugin/fixtures/manifest_cases.json)
// against the index admission so both validators agree.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateManifest } from "./package-lib.mjs";

const SNIFF_PACK = JSON.stringify({ format: "fluxdown-sniff-pack", rules: [] });
const cases = JSON.parse(readFileSync(new URL("./fixtures/manifest_cases.json", import.meta.url), "utf8"));

test("engine manifest fixtures", () => {
  assert.ok(cases.length >= 30);
  for (const item of cases) {
    const files = new Map(item.files.map((path) => [path, Buffer.from(path.endsWith(".json") ? SNIFF_PACK : "")]));
    const errors = validateManifest(item.manifest, files);
    assert.equal(errors.length === 0, item.ok, `${item.name}: ${errors.join("；")}`);
  }
});
