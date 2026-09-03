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
    return {
      chapterIndex,
      mixedByParagraph,
      completedCount: finiteInteger(raw?.completedCount ?? mixedByParagraph.length, "完成段落数"),
      totalCount: finiteInteger(raw?.totalCount ?? mixedByParagraph.length, "总段落数"),
    };
  });
  const uniqueIndexes = new Set(chapters.map((chapter) => chapter.chapterIndex));
  if (uniqueIndexes.size !== chapters.length) throw new Error("缓存章节重复");
  const translatedParagraphs = chapters.reduce((sum, chapter) =>
    sum + chapter.mixedByParagraph.filter(([, replacements]) => replacements.length > 0).length, 0);
  const replacements = chapters.reduce((sum, chapter) =>
    sum + chapter.mixedByParagraph.reduce((count, [, items]) => count + items.length, 0), 0);

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
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
    stats: { cachedChapters: chapters.length, translatedParagraphs, replacements },
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
  const targetBook = path.join(libraryDir, stagedBook.fileName);
  const targetManifest = path.join(libraryDir, "manifest.json");
  const manifestTemp = path.join(libraryDir, `.manifest-${stagedBook.token}.tmp`);
  fs.writeFileSync(manifestTemp, `${JSON.stringify(manifest)}\n`, { flag: "wx" });
  fs.copyFileSync(stagedBook.path, targetBook);
  fs.renameSync(manifestTemp, targetManifest);
  for (const obsolete of stagedBook.extension === '.epub' ? ['book.txt'] : ['book.epub']) {
    fs.rmSync(path.join(libraryDir, obsolete), { force: true });
  }
  fs.rmSync(stagedBook.path, { force: true });
  fs.rmSync(path.join(root, ".pages-export-staging", `${stagedBook.token}.json`), { force: true });
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
