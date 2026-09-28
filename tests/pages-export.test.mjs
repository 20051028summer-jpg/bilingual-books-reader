import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findStagedBook, mergePagesManifests, sanitizePagesManifest, stagePagesBook } from "../pages-export.mjs";

test("Pages manifest keeps reading data and strips model/API metadata", () => {
  const staged = { id: "demo.epub:4:123", fileName: "book.epub", bytes: 4, sha256: "a".repeat(64) };
  const manifest = sanitizePagesManifest({
    book: { id: staged.id, title: "示例书", format: "EPUB", chapterCount: 2 },
    apiKey: "must-not-leak",
    model: "must-not-leak",
    chapters: [{
      chapterIndex: 1,
      mixedByParagraph: [[0, [{ start: 0, end: 2, source: "拿起", replacement: "pick up", gloss: "拿起", confidence: 0.99 }]]],
      completedCount: 1,
      totalCount: 8,
      paragraphMeta: [[0, { model: "deepseek-v4-flash" }]],
    }],
  }, staged);
  assert.equal(manifest.stats.replacements, 1);
  assert.deepEqual(manifest.chapters[0].mixedByParagraph[0][1][0], {
    start: 0, end: 2, source: "拿起", replacement: "pick up",
  });
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes("must-not-leak"), false);
  assert.equal(serialized.includes("deepseek-v4-flash"), false);
  assert.equal(serialized.includes("confidence"), false);
  assert.equal(manifest.chapters[0].paragraphMeta[0][1].generatedAt > 0, true);
});

test("Pages manifest keeps the newest paragraph when local and Codex results are merged", () => {
  const book = { id: "demo", chapterCount: 2, sha256: "a".repeat(64) };
  const existing = {
    schemaVersion: 2, exportedAt: "2026-09-20T00:00:00.000Z", book,
    chapters: [{ chapterIndex: 1, totalCount: 2, mixedByParagraph: [
      [0, [{ start: 0, end: 2, source: "原文", replacement: "new" }]],
      [1, [{ start: 0, end: 2, source: "旧文", replacement: "kept" }]],
    ], paragraphMeta: [[0, { generatedAt: 300 }], [1, { generatedAt: 500 }]] }],
  };
  const incoming = {
    schemaVersion: 2, exportedAt: "2026-09-21T00:00:00.000Z", book,
    chapters: [{ chapterIndex: 1, totalCount: 2, mixedByParagraph: [
      [0, [{ start: 0, end: 2, source: "原文", replacement: "old" }]],
      [1, [{ start: 0, end: 2, source: "旧文", replacement: "latest" }]],
    ], paragraphMeta: [[0, { generatedAt: 200 }], [1, { generatedAt: 600 }]] }],
  };
  const merged = mergePagesManifests(existing, incoming);
  assert.equal(merged.chapters[0].mixedByParagraph[0][1][0].replacement, "new");
  assert.equal(merged.chapters[0].mixedByParagraph[1][1][0].replacement, "latest");
  assert.equal(merged.stats.replacements, 2);
});

test("staged book can only be found by its generated token", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wordnov-pages-"));
  try {
    const staged = stagePagesBook(root, Buffer.from("book"), {
      "x-book-name": encodeURIComponent("demo.epub"),
      "x-book-modified": "123",
    });
    const found = findStagedBook(root, staged.token);
    assert.equal(found.id, "demo.epub:4:123");
    assert.equal(found.bytes, 4);
    assert.equal(findStagedBook(root, "../../invalid"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
