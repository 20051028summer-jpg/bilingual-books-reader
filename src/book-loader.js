import ePub from "epubjs";
import { resolveEpubHref } from "./epub-links.js";

const chapterPattern = /^(?:\s*)(第[零〇一二三四五六七八九十百千万\d]+[章节卷回部篇]|chapter\s+\d+|序章|楔子|前言|后记|尾声)(?:\s|$)/i;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

const allowedInlineTags = new Map([
  ["EM", "em"], ["I", "i"], ["STRONG", "strong"], ["B", "b"],
  ["SMALL", "small"], ["SUB", "sub"], ["SUP", "sup"],
  ["RUBY", "ruby"], ["RT", "rt"], ["RP", "rp"], ["MARK", "mark"],
]);

function serializeInline(node) {
  if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.nodeValue ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tagName = String(node.localName || node.tagName).toUpperCase();
  if (tagName === "BR") return "<br>";
  const children = [...node.childNodes].map(serializeInline).join("");
  if (tagName === "A") {
    const href = node.getAttribute("href");
    if (!href) return children;
    return `<a href="#" class="epub-link" data-epub-href="${escapeHtml(href)}">${children}</a>`;
  }
  const safeTag = allowedInlineTags.get(tagName);
  return safeTag ? `<${safeTag}>${children}</${safeTag}>` : children;
}

function cleanParagraphs(document) {
  for (const node of document.querySelectorAll("script, style, noscript, svg")) node.remove();
  const blocks = [...document.querySelectorAll("h1, h2, h3, h4, p, blockquote, li")];
  const entries = blocks
    .filter((node) => !blocks.some((other) => other !== node && node.contains(other)))
    .map((node) => ({
      text: node.textContent.replace(/\s+/g, " ").trim(),
      html: [...node.childNodes].map(serializeInline).join("").trim(),
      anchors: [
        node.id,
        node.getAttribute("name"),
        ...[...node.querySelectorAll("[id], [name]")].flatMap((child) => [child.id, child.getAttribute("name")]),
      ].filter(Boolean),
      kind: /^H[1-4]$/.test(String(node.localName || node.tagName).toUpperCase()) ? "heading" : "paragraph",
    }))
    .filter((entry) => entry.text.length > 0);
  if (entries.length) return entries;
  return document.body?.textContent
    .split(/\n{2,}/)
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((text) => ({ text, html: escapeHtml(text), anchors: [], kind: "paragraph" })) ?? [];
}

function normalizeHref(value = "") {
  return decodeURIComponent(value.split("#")[0]).replace(/^\.\//, "");
}

function flattenToc(items, result = []) {
  for (const item of items ?? []) {
    result.push(item);
    flattenToc(item.subitems, result);
  }
  return result;
}

function metadataTerms(...values) {
  const terms = [];
  const visit = (value) => {
    if (typeof value === "string") terms.push(value.trim());
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      visit(value.name);
      visit(value.value);
    }
  };
  values.forEach(visit);
  return [...new Set(terms.filter((term) => term.length >= 2 && term.length <= 100))];
}

export async function loadEpub(file) {
  const buffer = await file.arrayBuffer();
  const book = ePub(buffer);
  await book.ready;
  const navigation = await book.loaded.navigation;
  const toc = flattenToc(navigation?.toc ?? []);
  const chapters = book.spine.spineItems.map((section, index) => {
    const href = normalizeHref(section.href);
    const tocItem = toc.find((item) => {
      const tocHref = normalizeHref(item.href);
      return tocHref === href || tocHref.endsWith(`/${href}`) || href.endsWith(`/${tocHref}`);
    });
    return {
      id: `epub-${index}`,
      title: tocItem?.label?.trim() || `第 ${index + 1} 节`,
      href: section.href,
      paragraphs: null,
      async load() {
        const doc = await section.load(book.load.bind(book));
        const paragraphs = attachNavigationFallback(cleanParagraphs(doc));
        section.unload();
        this.paragraphs = paragraphs;
        return paragraphs;
      },
    };
  });
  const titleCounts = new Map();
  for (const chapter of chapters) titleCounts.set(chapter.title, (titleCounts.get(chapter.title) ?? 0) + 1);
  const uniqueTitleTargets = new Map(
    chapters
      .filter((chapter) => titleCounts.get(chapter.title) === 1)
      .map((chapter) => [chapter.title, chapter]),
  );

  function attachNavigationFallback(paragraphs) {
    return paragraphs.map((entry) => {
      if (entry.html?.includes("data-epub-href")) return entry;
      const target = uniqueTitleTargets.get(entry.text);
      if (!target) return entry;
      const absoluteBookHref = `/${normalizeHref(target.href)}`;
      return {
        ...entry,
        html: `<a href="#" class="epub-link" data-epub-href="${escapeHtml(absoluteBookHref)}">${entry.html}</a>`,
      };
    });
  }
  return {
    id: `${file.name}:${file.size}:${file.lastModified}`,
    title: book.packaging?.metadata?.title || file.name.replace(/\.epub$/i, ""),
    protectedTerms: metadataTerms(
      book.packaging?.metadata?.title,
      book.packaging?.metadata?.creator,
      book.packaging?.metadata?.creators,
    ),
    format: "EPUB",
    chapters,
    resolveLink: (currentIndex, href) => resolveEpubHref(chapters, currentIndex, href),
    destroy: () => book.destroy(),
  };
}

function decodeText(buffer) {
  for (const encoding of ["utf-8", "gb18030"]) {
    try {
      const text = new TextDecoder(encoding, { fatal: encoding === "utf-8" }).decode(buffer);
      if (!text.includes("�")) return text;
    } catch {
      // Try the next supported encoding.
    }
  }
  return new TextDecoder("utf-8").decode(buffer);
}

export async function loadTxt(file) {
  const text = decodeText(await file.arrayBuffer()).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const chapters = [];
  let current = { title: "正文", lines: [] };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && chapterPattern.test(trimmed)) {
      if (current.lines.some(Boolean)) chapters.push(current);
      current = { title: trimmed, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.some(Boolean) || !chapters.length) chapters.push(current);
  return {
    id: `${file.name}:${file.size}:${file.lastModified}`,
    title: file.name.replace(/\.txt$/i, ""),
    protectedTerms: metadataTerms(file.name.replace(/\.txt$/i, "")),
    format: "TXT",
    chapters: chapters.map((chapter, index) => ({
      id: `txt-${index}`,
      title: chapter.title,
      paragraphs: chapter.lines.map((line) => line.trim()).filter(Boolean).map((line) => ({
        text: line,
        html: null,
        anchors: [],
        kind: chapterPattern.test(line) ? "heading" : "paragraph",
      })),
      async load() { return this.paragraphs; },
    })),
    resolveLink: () => null,
    destroy: () => {},
  };
}

export async function loadBook(file) {
  if (/\.epub$/i.test(file.name)) return loadEpub(file);
  if (/\.txt$/i.test(file.name)) return loadTxt(file);
  throw new Error("目前只支持 .txt 和 .epub 文件");
}
