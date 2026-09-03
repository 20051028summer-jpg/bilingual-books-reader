import test from "node:test";
import assert from "node:assert/strict";
import { resolveEpubHref } from "../src/epub-links.js";

const chapters = [
  { href: "Text/cover.xhtml" },
  { href: "Text/toc.xhtml" },
  { href: "Text/volume-21.xhtml" },
];

test("resolves an EPUB relative chapter link and fragment", () => {
  assert.deepEqual(resolveEpubHref(chapters, 1, "volume-21.xhtml#chapter-3"), {
    external: false,
    index: 2,
    fragment: "chapter-3",
  });
});

test("resolves a same-document fragment", () => {
  assert.deepEqual(resolveEpubHref(chapters, 2, "#chapter-9"), {
    external: false,
    index: 2,
    fragment: "chapter-9",
  });
});

test("keeps external links external", () => {
  assert.deepEqual(resolveEpubHref(chapters, 1, "https://example.com/help"), {
    external: true,
    url: "https://example.com/help",
  });
});

test("rejects a missing internal target", () => {
  assert.equal(resolveEpubHref(chapters, 1, "missing.xhtml"), null);
});
