import test from "node:test";
import assert from "node:assert/strict";
import { renderMixedHtml } from "../src/mixed-renderer.js";

test("renders English initially and stores the exact Chinese source for click toggling", () => {
  const html = renderMixedHtml("他碰到一个前辈。", [
    {
      start: 1,
      end: 3,
      source: "碰到",
      replacement: "encountered",
      lemma: "encounter",
      gloss: "碰见",
      confidence: 0.96,
    },
    {
      start: 5,
      end: 7,
      source: "前辈",
      replacement: "senior",
      lemma: "senior",
      gloss: "资历较深的人",
      confidence: 0.95,
    },
  ]);

  assert.match(html, />encountered<\/button>/);
  assert.match(html, /data-source="碰到"/);
  assert.match(html, /data-english="senior"/);
  assert.match(html, /data-showing="english"/);
  assert.doesNotMatch(html, /data-tip|碰见|资历较深的人/);
});

test("escapes source and replacement values in toggle attributes", () => {
  const html = renderMixedHtml("他说“碰到”。", [{
    start: 3,
    end: 5,
    source: "碰到",
    replacement: "met's",
    lemma: "meet",
    gloss: "",
    confidence: 0.95,
  }]);
  assert.match(html, /data-english="met&#39;s"/);
});

