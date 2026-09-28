import test from "node:test";
import assert from "node:assert/strict";
import { publishedRecordsForBook } from "../src/published-sync.js";

test("published manifest becomes a shared IndexedDB chapter record", () => {
  const result = publishedRecordsForBook("book:1", {
    book: { id: "book:1" },
    chapters: [{
      chapterIndex: 75,
      mixedByParagraph: [[1, [{ start: 0, end: 2, source: "无边", replacement: "boundless" }]]],
      paragraphMeta: [[1, { generatedAt: 1234 }]],
      completedCount: 1,
      totalCount: 1,
    }],
  });

  assert.equal(result.compatible, true);
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.records[0], {
    schemaVersion: 3,
    bookId: "book:1",
    chapterIndex: 75,
    shared: true,
    updatedAt: 1234,
    mixedByParagraph: [[1, [{ start: 0, end: 2, source: "无边", replacement: "boundless" }]]],
    paragraphMeta: [[1, { generatedAt: 1234 }]],
    diagnosticsByParagraph: [],
    completedCount: 1,
    totalCount: 1,
    complete: true,
    summary: { acceptedCount: 1 },
  });
});

test("published manifest for another book is ignored", () => {
  assert.deepEqual(publishedRecordsForBook("book:1", {
    book: { id: "book:2" },
    chapters: [],
  }), { compatible: false, records: [], reason: "book_mismatch" });
});
