import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findStagedBook, sanitizePagesManifest, stagePagesBook } from "../pages-export.mjs";

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
