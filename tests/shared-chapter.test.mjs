import test from "node:test";
import assert from "node:assert/strict";
import { mergeSharedChapter } from "../src/shared-chapter.js";
import { chapterCacheKeys, legacyChapterIndex } from "../src/cache-keys.js";
import { runChapterTranslation } from "../src/chapter-runner.js";

const identity = { bookId: "book.epub:100:200", chapterIndex: 14 };
const old = { key: "old", value: { model: "deepseek-v4-flash", createdAt: 1000,
  mixedByParagraph: Array.from({ length: 85 }, (_, id) => [id, [{ source: "旧词", replacement: `old-${id}` }]]) } };
const recent = { key: "new", value: { model: "qwen-flash", thinking: "disabled", updatedAt: 2000,
  totalCount: 85, mixedByParagraph: Array.from({ length: 6 }, (_, id) => [id, [{ source: "新词", replacement: `new-${id}` }]]) } };

test("merges full 85 paragraphs with newer 6; preserves the remaining 79 verbatim", () => {
  const merged = mergeSharedChapter([recent, old], identity);
  assert.equal(merged.completedCount, 85);
  assert.equal(merged.totalCount, 85);
  assert.equal(merged.complete, true);
  assert.deepEqual(merged.mixedByParagraph.slice(0, 6), recent.value.mixedByParagraph);
  assert.deepEqual(merged.mixedByParagraph.slice(6), old.value.mixedByParagraph.slice(6));
  assert.equal(new Map(merged.paragraphMeta).get(0).model, "qwen-flash");
  assert.equal(new Map(merged.paragraphMeta).get(6).model, "deepseek-v4-flash");
});

test("newer empty replacement array replaces the old paragraph rather than unioning words", () => {
  const result = mergeSharedChapter([old, { key: "empty", value: { updatedAt: 3000, mixedByParagraph: [[0, []]] } }], identity);
  assert.deepEqual(result.mixedByParagraph[0], [0, []]);
  assert.equal(result.completedCount, 85);
});

test("late checkpoint or model switch cannot make stale paragraph content win", async () => {
  const merged = mergeSharedChapter([old, recent], identity);
  const stale = { ...merged, updatedAt: 9000, mixedByParagraph: [[0, old.value.mixedByParagraph[0][1]]],
    paragraphMeta: [[0, { generatedAt: 1000, model: "old" }]] };
  const final = mergeSharedChapter([{ key: "shared", value: merged }, { key: "stale", value: stale }], identity);
  assert.deepEqual(final.mixedByParagraph[0], recent.value.mixedByParagraph[0]);
  const paragraphs = Array.from({ length: 85 }, (_, id) => ({ id, text: "这是已经完成替换的测试段落，不需要再次请求模型。" }));
  const run = await runChapterTranslation({ paragraphs, initial: final,
    metadata: { ...identity, model: "third-model", thinking: "max" }, now: () => 10000,
    persist: async () => {}, requestBatch: () => { throw new Error("completed content must not regenerate"); } });
  assert.equal(run.error, null);
  assert.equal(new Map(run.snapshot.paragraphMeta).get(0).generatedAt, 2000);
  assert.equal(new Map(run.snapshot.paragraphMeta).get(6).generatedAt, 1000);
});

test("chapter key ignores generation settings but isolates books and chapter numbers", () => {
  const a = chapterCacheKeys({ ...identity, model: "A", thinking: "high", level: "cet6", density: "dense" });
  const b = chapterCacheKeys({ ...identity, model: "B", thinking: "disabled", level: "cet4", density: "light" });
  assert.equal(a.current, b.current);
  assert.notEqual(a.current, chapterCacheKeys({ ...identity, chapterIndex: 15 }).current);
  assert.notEqual(a.current, chapterCacheKeys({ ...identity, bookId: "other" }).current);
  assert.equal(legacyChapterIndex(`${identity.bookId}:14:cet6:medium:v4:model=deepseek-v4-flash`, identity.bookId), 14);
  assert.equal(legacyChapterIndex(`${identity.bookId}0:14:cet6:medium:v4`, identity.bookId), null);
});

test("repeated migration is idempotent and incomplete union keeps its true total", () => {
  const once = mergeSharedChapter([old, recent], identity);
  assert.deepEqual(mergeSharedChapter([{ key: "shared", value: once }, old, recent], identity), once);
  const partial = mergeSharedChapter([recent], identity);
  assert.equal(partial.complete, false);
  assert.equal(partial.totalCount, 85);
});
