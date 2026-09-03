import assert from "node:assert/strict";
import test from "node:test";
import { findPublishedMatches } from "../pages-reader/search-index.js";

const chapters = [
  {
    chapterIndex: 14,
    mixedByParagraph: [
      [0, [
        { source: "商旅", replacement: "merchants" },
        { source: "老气横秋", replacement: "old-fashioned arrogance" },
      ]],
      [1, [{ source: "惧怕", replacement: "feared" }]],
    ],
  },
  {
    chapterIndex: 17,
    mixedByParagraph: [[5, [{ source: "惧怕", replacement: "feared" }]]],
  },
];

test("finds an English replacement across published chapters", () => {
  const result = findPublishedMatches(chapters, "FEARED");
  assert.equal(result.totalParagraphs, 2);
  assert.equal(result.totalOccurrences, 2);
  assert.deepEqual(result.matches.map(({ chapterIndex, paragraphIndex }) => [chapterIndex, paragraphIndex]), [[14, 1], [17, 5]]);
});

test("finds the corresponding Chinese source and limits rendered paragraphs", () => {
  const result = findPublishedMatches(chapters, "惧怕", 1);
  assert.equal(result.totalParagraphs, 2);
  assert.equal(result.matches.length, 1);
  assert.equal(result.truncated, true);
});

test("does not search untranslated prose outside published replacement records", () => {
  assert.equal(findPublishedMatches(chapters, "不存在于替换中的正文").totalParagraphs, 0);
});
