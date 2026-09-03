import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModelProfiles } from "../model-profiles.mjs";
import { chapterCacheKeys, readModelChapterCache } from "../src/cache-keys.js";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reader-model-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, ".model-profiles.local.json");
}

test("legacy key migrates once; A → B → A restores each key across restart", (t) => {
  const file = fixture(t);
  const store = createModelProfiles(file, { model: "qwen-flash", apiKey: "sk-original" });
  assert.equal(store.get().apiKey, "sk-original");
  store.save({ model: "another-model", apiKey: "sk-second" });
  assert.equal(store.get().model, "another-model");
  const restarted = createModelProfiles(file, { model: "qwen-flash", apiKey: "sk-stale-env" });
  assert.equal(restarted.get().model, "another-model");
  assert.equal(restarted.get().apiKey, "sk-second");
  restarted.save({ model: "qwen-flash", apiKey: "" });
  assert.equal(restarted.get().apiKey, "sk-original");
  restarted.save({ model: "another-model" });
  assert.equal(restarted.get().apiKey, "sk-second");
  assert.deepEqual(restarted.publicStatus(), {
    model: "another-model", configured: true, savedModels: ["another-model", "qwen-flash"],
    thinking: "disabled", concurrency: 3,
    savedSettings: { "another-model": { thinking: "disabled", concurrency: 3 }, "qwen-flash": { thinking: "disabled", concurrency: 3 } },
  });
  assert.ok(!JSON.stringify(restarted.publicStatus()).includes("sk-"));
});

test("new model requires a key; invalid input preserves disk and active model", (t) => {
  const file = fixture(t);
  const store = createModelProfiles(file, { apiKey: "sk-existing" });
  const before = fs.readFileSync(file, "utf8");
  for (const config of [
    { model: "new-model" }, { model: "" }, { model: "__proto__", apiKey: "sk-test" },
    { model: "bad\nmodel", apiKey: "sk-test" }, { model: "new-model", apiKey: "invalid" },
    { model: "new-model", apiKey: "sk-x\ny" },
  ]) assert.throws(() => store.save(config));
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(store.get().model, "qwen-flash");
});

test("updating one model preserves other keys and in-flight profile snapshots", (t) => {
  const store = createModelProfiles(fixture(t), { apiKey: "sk-original" });
  const snapshot = store.get();
  store.save({ model: "vendor/new-model:v1", apiKey: "sk-other" });
  store.save({ model: "qwen-flash", apiKey: "sk-updated" });
  assert.equal(store.get("vendor/new-model:v1").apiKey, "sk-other");
  assert.equal(store.get().apiKey, "sk-updated");
  assert.equal(snapshot.apiKey, "sk-original");
});

test("fresh setup is unconfigured; malformed saved file is not overwritten", (t) => {
  const file = fixture(t);
  const store = createModelProfiles(file);
  assert.equal(store.publicStatus().configured, false);
  assert.deepEqual(store.publicStatus().savedModels, []);
  store.save({ model: "qwen-flash", apiKey: "sk-first" });
  fs.writeFileSync(file, "{broken");
  assert.throws(() => createModelProfiles(file, { apiKey: "sk-legacy" }), /原文件未被覆盖/);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});

test("all models share the same chapter cache", async () => {
  const input = { bookId: "book", chapterIndex: 1, level: "cet6", density: "medium", version: "v4" };
  const a = chapterCacheKeys({ ...input, model: "qwen-flash" });
  const b = chapterCacheKeys({ ...input, model: "another-model" });
  assert.equal(a.current, b.current);
  const old = { model: "qwen-flash", mixedByParagraph: [[0, []]] };
  const data = new Map([[a.current, old]]);
  assert.equal(await readModelChapterCache((key) => data.get(key), a, "qwen-flash"), old);
  assert.equal(await readModelChapterCache((key) => data.get(key), b, "another-model"), old);
  const newer = { model: "another-model", thinking: "disabled", mixedByParagraph: [] };
  data.set(b.current, newer);
  assert.equal(await readModelChapterCache((key) => data.get(key), b, "another-model"), newer);
});

test("thinking and parallelism persist per model, blank key preserves credentials", (t) => {
  const file = fixture(t);
  const store = createModelProfiles(file, { apiKey: "sk-existing" });
  store.save({ model: "qwen-flash", thinking: "enabled", concurrency: 6 });
  store.save({ model: "second", apiKey: "sk-other", thinking: "default", concurrency: 2 });
  const restored = createModelProfiles(file);
  restored.save({ model: "qwen-flash" });
  assert.equal(restored.get().thinking, "high");
  assert.equal(restored.get().concurrency, 6);
  assert.equal(restored.get().apiKey, "sk-existing");
  assert.equal(restored.get("second").thinking, "disabled");
  assert.throws(() => restored.save({ thinking: "invalid" }));
  assert.throws(() => restored.save({ concurrency: 100 }));
});

test("thinking mode changes keep the shared chapter content visible", async () => {
  const input = { bookId: "book", chapterIndex: 1, level: "cet6", density: "medium", version: "v4", model: "qwen-flash" };
  const disabled = chapterCacheKeys({ ...input, thinking: "disabled" });
  const enabled = chapterCacheKeys({ ...input, thinking: "enabled" });
  const old = { model: "qwen-flash", mixedByParagraph: [[0, []]] };
  const data = new Map([[disabled.current, old]]);
  assert.equal(disabled.current, enabled.current);
  assert.equal(await readModelChapterCache((key) => data.get(key), disabled, "qwen-flash"), old);
  assert.equal(await readModelChapterCache((key) => data.get(key), enabled, "qwen-flash"), old);
});
