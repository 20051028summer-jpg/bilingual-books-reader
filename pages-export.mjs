import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_BOOK_BYTES = 100 * 1024 * 1024;
const MAX_CHAPTERS = 10000;
const MAX_PARAGRAPHS_PER_CHAPTER = 10000;
const MAX_REPLACEMENTS_PER_PARAGRAPH = 1000;

function boundedString(value, field, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${field} 无效`);
  return value.trim();
}

function finiteInteger(value, field, minimum = 0) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) throw new Error(`${field} 无效`);
  return number;
}

function sanitizeReplacement(value) {
  if (!value || typeof value !== "object") throw new Error("替换项无效");
  const source = boundedString(value.source, "替换原文", 300);
  const replacement = boundedString(value.replacement, "英文替换", 300);
  const start = finiteInteger(value.start, "替换起点");
  const end = finiteInteger(value.end, "替换终点", start + 1);
  if (end <= start) throw new Error("替换范围无效");
  return { start, end, source, replacement };
}

function generatedAt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function manifestStats(chapters) {
  const translatedParagraphs = chapters.reduce((sum, chapter) =>
    sum + chapter.mixedByParagraph.filter(([, replacements]) => replacements.length > 0).length, 0);
  const replacements = chapters.reduce((sum, chapter) =>
    sum + chapter.mixedByParagraph.reduce((count, [, items]) => count + items.length, 0), 0);
  return { cachedChapters: chapters.length, translatedParagraphs, replacements };
}

function chapterMetaMap(chapter, fallback) {
  return new Map((Array.isArray(chapter?.paragraphMeta) ? chapter.paragraphMeta : [])
    .filter((entry) => Array.isArray(entry) && Number.isInteger(Number(entry[0])))
    .map(([id, meta]) => [Number(id), generatedAt(meta?.generatedAt ?? meta, fallback)]));
}

export function sanitizePagesManifest(input, stagedBook) {
  if (!input || typeof input !== "object" || !stagedBook) throw new Error("发布数据无效");
  const bookId = boundedString(input.book?.id, "书籍 ID", 1000);
  const title = boundedString(input.book?.title, "书名", 500);
  const format = String(input.book?.format || "").toUpperCase();
  if (!['EPUB', 'TXT'].includes(format)) throw new Error("只支持 EPUB 或 TXT");
  if (input.book?.id !== stagedBook.id) throw new Error("书籍 ID 与上传文件不一致");
  const chapterCount = finiteInteger(input.book?.chapterCount, "章节数", 1);
  if (chapterCount > MAX_CHAPTERS) throw new Error("章节数过多");
  const rawChapters = Array.isArray(input.chapters) ? input.chapters : [];
  if (rawChapters.length > MAX_CHAPTERS) throw new Error("缓存章节数过多");

  const exportedAt = new Date().toISOString();
  const exportedAtMs = Date.parse(exportedAt);
  const chapters = rawChapters.map((raw) => {
    const chapterIndex = finiteInteger(raw?.chapterIndex, "章节序号");
    if (chapterIndex >= chapterCount) throw new Error("章节序号超出范围");
    const rawParagraphs = Array.isArray(raw?.mixedByParagraph) ? raw.mixedByParagraph : [];
    if (rawParagraphs.length > MAX_PARAGRAPHS_PER_CHAPTER) throw new Error("单章段落数过多");
    const mixedByParagraph = rawParagraphs.map((entry) => {
      if (!Array.isArray(entry) || !Array.isArray(entry[1])) throw new Error("段落缓存无效");
      const paragraphIndex = finiteInteger(entry[0], "段落序号");
      if (entry[1].length > MAX_REPLACEMENTS_PER_PARAGRAPH) throw new Error("单段替换项过多");
      return [paragraphIndex, entry[1].map(sanitizeReplacement)];
    });
    const fallback = generatedAt(raw?.updatedAt, exportedAtMs);
    const meta = chapterMetaMap(raw, fallback);
    const chapter = {
      chapterIndex,
      mixedByParagraph,
      paragraphMeta: mixedByParagraph.map(([id]) => [id, { generatedAt: meta.get(id) ?? fallback }]),
      completedCount: finiteInteger(raw?.completedCount ?? mixedByParagraph.length, "完成段落数"),
      totalCount: finiteInteger(raw?.totalCount ?? mixedByParagraph.length, "总段落数"),
    };
    if (typeof raw?.title === "string" && raw.title.trim()) chapter.title = raw.title.trim().slice(0, 500);
    return chapter;
  });
  const uniqueIndexes = new Set(chapters.map((chapter) => chapter.chapterIndex));
  if (uniqueIndexes.size !== chapters.length) throw new Error("缓存章节重复");
  return {
    schemaVersion: 2,
    exportedAt,
    book: {
      id: bookId,
      title,
      format,
      chapterCount,
      asset: `library/${stagedBook.fileName}`,
      bytes: stagedBook.bytes,
      sha256: stagedBook.sha256,
    },
    chapters,
    stats: manifestStats(chapters),
  };
}

export function mergePagesManifests(existing, incoming) {
  if (!existing || typeof existing !== "object") return incoming;
  if (existing.book?.sha256 !== incoming.book?.sha256 || existing.book?.chapterCount !== incoming.book?.chapterCount) {
    return incoming;
  }
  const oldFallback = Number.isFinite(Date.parse(existing.exportedAt)) ? Date.parse(existing.exportedAt) : 1;
  const newFallback = Number.isFinite(Date.parse(incoming.exportedAt)) ? Date.parse(incoming.exportedAt) : Date.now();
  const merged = new Map();

  function addChapter(chapter, fallback, preferOnTie) {
    const chapterIndex = Number(chapter?.chapterIndex);
    if (!Number.isInteger(chapterIndex)) return;
    const current = merged.get(chapterIndex) ?? {
      chapterIndex,
      title: "",
      totalCount: 0,
      paragraphs: new Map(),
    };
    if (chapter?.title) current.title = chapter.title;
    current.totalCount = Math.max(current.totalCount, Number(chapter?.totalCount) || 0);
    const meta = chapterMetaMap(chapter, fallback);
    for (const entry of Array.isArray(chapter?.mixedByParagraph) ? chapter.mixedByParagraph : []) {
      if (!Array.isArray(entry) || !Number.isInteger(Number(entry[0])) || !Array.isArray(entry[1])) continue;
      const id = Number(entry[0]);
      const candidate = { replacements: entry[1], generatedAt: meta.get(id) ?? fallback };
      const previous = current.paragraphs.get(id);
      if (!previous || candidate.generatedAt > previous.generatedAt || (preferOnTie && candidate.generatedAt === previous.generatedAt)) {
        current.paragraphs.set(id, candidate);
      }
    }
    merged.set(chapterIndex, current);
  }

  for (const chapter of Array.isArray(existing.chapters) ? existing.chapters : []) addChapter(chapter, oldFallback, false);
  for (const chapter of Array.isArray(incoming.chapters) ? incoming.chapters : []) addChapter(chapter, newFallback, true);
  const chapters = [...merged.values()].sort((a, b) => a.chapterIndex - b.chapterIndex).map((chapter) => {
    const entries = [...chapter.paragraphs.entries()].sort((a, b) => a[0] - b[0]);
    const value = {
      chapterIndex: chapter.chapterIndex,
      mixedByParagraph: entries.map(([id, item]) => [id, item.replacements]),
      paragraphMeta: entries.map(([id, item]) => [id, { generatedAt: item.generatedAt }]),
      completedCount: entries.length,
      totalCount: Math.max(chapter.totalCount, entries.length),
    };
    if (chapter.title) value.title = chapter.title;
    return value;
  });
  return {
    ...incoming,
    schemaVersion: Math.max(Number(existing.schemaVersion) || 1, Number(incoming.schemaVersion) || 1, 2),
    chapters,
    stats: manifestStats(chapters),
  };
}

export function stagePagesBook(root, body, headers) {
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_BOOK_BYTES) throw new Error("原书文件为空或超过 100 MB");
  let name;
  try { name = decodeURIComponent(headers["x-book-name"] || ""); } catch { throw new Error("书名编码无效"); }
  name = boundedString(name, "文件名", 500);
  const extension = path.extname(name).toLowerCase();
  if (!['.epub', '.txt'].includes(extension)) throw new Error("只支持 EPUB 或 TXT");
  const modified = finiteInteger(headers["x-book-modified"] || 0, "文件修改时间");
  const id = `${name}:${body.length}:${modified}`;
  const token = crypto.randomUUID();
  const stagingDir = path.join(root, ".pages-export-staging");
  fs.mkdirSync(stagingDir, { recursive: true });
  const stagingPath = path.join(stagingDir, `${token}${extension}`);
  fs.writeFileSync(stagingPath, body, { flag: "wx" });
  const staged = {
    token,
    path: stagingPath,
    id,
    extension,
    fileName: `book${extension}`,
    bytes: body.length,
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
  };
  fs.writeFileSync(path.join(stagingDir, `${token}.json`), JSON.stringify({ id, extension }), { flag: "wx" });
  return staged;
}

export function publishStagedPagesBook(root, stagedBook, manifest) {
  const libraryDir = path.join(root, "pages-reader", "public", "library");
  fs.mkdirSync(libraryDir, { recursive: true });
  const booksDir = path.join(libraryDir, "books");
  const manifestsDir = path.join(libraryDir, "manifests");
  fs.mkdirSync(booksDir, { recursive: true });
  fs.mkdirSync(manifestsDir, { recursive: true });
  const extension = stagedBook.extension;
  const assetName = `books/${stagedBook.sha256}${extension}`;
  const manifestName = `manifests/${stagedBook.sha256}.json`;
  const targetBook = path.join(libraryDir, assetName);
  const targetBookManifest = path.join(libraryDir, manifestName);
  const targetManifest = path.join(libraryDir, "manifest.json");
  const catalogPath = path.join(libraryDir, "catalog.json");
  const manifestTemp = path.join(libraryDir, `.manifest-${stagedBook.token}.tmp`);
  const bookManifestTemp = path.join(manifestsDir, `.${stagedBook.sha256}-${stagedBook.token}.tmp`);
  const catalogTemp = path.join(libraryDir, `.catalog-${stagedBook.token}.tmp`);
  let previousCatalog;
  let legacyManifest;
  try { previousCatalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")); } catch { previousCatalog = null; }
  if (!Array.isArray(previousCatalog?.books)) {
    try { legacyManifest = JSON.parse(fs.readFileSync(targetManifest, "utf8")); } catch { legacyManifest = null; }
  }

  const catalogBooks = Array.isArray(previousCatalog?.books)
    ? [...previousCatalog.books]
    : [];
  const manifestByName = new Map();
  for (const entry of catalogBooks) {
    if (typeof entry?.sha256 === "string" && /^[a-f0-9]{64}$/i.test(entry.sha256)) {
      const relativeManifest = String(entry.manifest || "").replace(/^library\//, "");
      try { manifestByName.set(entry.sha256, JSON.parse(fs.readFileSync(path.join(libraryDir, relativeManifest), "utf8"))); } catch { /* Preserve catalog entry for repair on the next export. */ }
    }
  }
  if (legacyManifest?.book?.sha256 && !catalogBooks.some((entry) => entry.sha256 === legacyManifest.book.sha256)) {
    const legacyHash = legacyManifest.book.sha256;
    const legacyName = `manifests/${legacyHash}.json`;
    fs.writeFileSync(path.join(libraryDir, legacyName), `${JSON.stringify(legacyManifest)}\n`);
    manifestByName.set(legacyHash, legacyManifest);
    catalogBooks.push({
      sha256: legacyHash,
      title: legacyManifest.book.title,
      format: legacyManifest.book.format,
      chapterCount: legacyManifest.book.chapterCount,
      bytes: legacyManifest.book.bytes,
      asset: legacyManifest.book.asset,
      manifest: `library/${legacyName}`,
      exportedAt: legacyManifest.exportedAt,
      stats: legacyManifest.stats,
    });
  }

  const bookManifest = {
    ...manifest,
    book: { ...manifest.book, asset: `library/${assetName}` },
  };
  const existingBookManifest = manifestByName.get(stagedBook.sha256);
  const published = mergePagesManifests(existingBookManifest, bookManifest);
  const entry = {
    sha256: stagedBook.sha256,
    title: published.book.title,
    format: published.book.format,
    chapterCount: published.book.chapterCount,
    bytes: stagedBook.bytes,
    asset: published.book.asset,
    manifest: `library/${manifestName}`,
    exportedAt: published.exportedAt,
    stats: published.stats,
  };
  const entryIndex = catalogBooks.findIndex((item) => item.sha256 === stagedBook.sha256);
  if (entryIndex >= 0) catalogBooks[entryIndex] = entry;
  else catalogBooks.push(entry);
  catalogBooks.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh-CN"));
  const catalog = { schemaVersion: 1, exportedAt: new Date().toISOString(), books: catalogBooks };

  fs.writeFileSync(manifestTemp, `${JSON.stringify(published)}\n`, { flag: "wx" });
  fs.writeFileSync(bookManifestTemp, `${JSON.stringify(published)}\n`, { flag: "wx" });
  fs.writeFileSync(catalogTemp, `${JSON.stringify(catalog)}\n`, { flag: "wx" });
  fs.mkdirSync(path.dirname(targetBook), { recursive: true });
  fs.copyFileSync(stagedBook.path, targetBook);
  fs.renameSync(bookManifestTemp, targetBookManifest);
  fs.renameSync(catalogTemp, catalogPath);
  fs.renameSync(manifestTemp, targetManifest);
  fs.rmSync(stagedBook.path, { force: true });
  fs.rmSync(path.join(root, ".pages-export-staging", `${stagedBook.token}.json`), { force: true });
  return { ...published, catalog };
}

export function findStagedBook(root, token) {
  if (typeof token !== "string" || !/^[0-9a-f-]{36}$/i.test(token)) return null;
  const stagingDir = path.join(root, ".pages-export-staging");
  const metadataPath = path.join(stagingDir, `${token}.json`);
  if (!fs.existsSync(metadataPath)) return null;
  let metadata;
  try { metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")); } catch { return null; }
  for (const extension of ['.epub', '.txt']) {
    const candidate = path.join(stagingDir, `${token}${extension}`);
    if (!fs.existsSync(candidate)) continue;
    const buffer = fs.readFileSync(candidate);
    return {
      token,
      path: candidate,
      id: metadata.id,
      extension,
      fileName: `book${extension}`,
      bytes: buffer.length,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    };
  }
  return null;
}
