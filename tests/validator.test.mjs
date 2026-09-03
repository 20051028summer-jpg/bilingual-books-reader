import test from "node:test";
import assert from "node:assert/strict";
import { renderMixedSegments, validateReplacements } from "../src/validator.js";

test("accepts a complete contextual phrase", () => {
  const text = "她戴着一枚精致的发卡。";
  const result = validateReplacements(text, [{
    source: "精致的发卡",
    replacement: "delicate hair clip",
    lemma: "delicate; hair clip",
    gloss: "精致的发卡",
    confidence: 0.96,
  }]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
  const rendered = renderMixedSegments(text, result.accepted).map((item) => item.text).join("");
  assert.equal(rendered, "她戴着一枚delicate hair clip。");
});

test("rejects a substring that breaks a Chinese word boundary", () => {
  const text = "这个念头浮现在他的脑海里。";
  const result = validateReplacements(text, [{
    source: "海",
    replacement: "submarine",
    confidence: 0.99,
  }]);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].reason, "source_not_complete_chinese_unit");
});

test("rejects ambiguous repeated source text", () => {
  const text = "微风吹过，微风又停了。";
  const result = validateReplacements(text, [{ source: "微风", replacement: "breeze", confidence: 0.95 }]);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].reason, "source_ambiguous");
});

test("rejects overlapping candidates and low confidence guesses", () => {
  const text = "她露出温柔的笑容。";
  const result = validateReplacements(text, [
    { source: "温柔的笑容", replacement: "gentle smile", confidence: 0.95 },
    { source: "笑容", replacement: "smile", confidence: 0.95 },
    { source: "温柔", replacement: "gentle", confidence: 0.5 },
  ]);
  assert.equal(result.accepted.length, 1);
  assert.ok(result.rejected.some((item) => item.reason === "overlaps_existing_replacement"));
  assert.ok(result.rejected.some((item) => item.reason === "confidence_too_low"));
});

test("rejects person-name transliterations even when the model is confident", () => {
  const text = "这是黄易最长的一部作品。";
  const result = validateReplacements(text, [{
    source: "黄易",
    replacement: "Mr. Huang Yi",
    lemma: "Huang Yi",
    gloss: "作者名",
    confidence: 0.99,
  }], {
    rejectProperNouns: true,
    protectedTerms: ["黄易"],
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].reason, "proper_noun_or_transliteration");
});

test("rejects work titles enclosed by Chinese title marks", () => {
  const text = "《大唐双龙传》共六十三卷。";
  const result = validateReplacements(text, [{
    source: "大唐双龙传",
    replacement: "twin dragons",
    lemma: "dragon",
    gloss: "作品名",
    confidence: 0.99,
  }], {
    rejectProperNouns: true,
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].reason, "proper_noun_or_transliteration");
});
