import "./styles.css";
import { loadBook } from "../src/book-loader.js";
import { renderMixedHtml } from "../src/mixed-renderer.js";

const app = document.querySelector("#app");
const state = {
  manifest: null,
  book: null,
  chapterIndex: 0,
  paragraphs: [],
  mixedByParagraph: new Map(),
  cacheByChapter: new Map(),
  search: "",
};

function paragraphText(entry) {
  return typeof entry === "string" ? entry : entry?.text || "";
}

function setStatus(message, kind = "info") {
  const node = document.querySelector("#status");
  node.textContent = message;
  node.dataset.kind = kind;
}

function renderParagraph(entry, index) {
  const replacements = state.mixedByParagraph.get(index);
  if (replacements) return renderMixedHtml(paragraphText(entry), replacements);
  if (entry?.html) return entry.html;
  const node = document.createElement("span");
  node.textContent = paragraphText(entry);
  return node.innerHTML;
}

function renderReader() {
  const reader = document.querySelector("#reader");
  reader.innerHTML = state.paragraphs.map((entry, index) => {
    const className = entry?.kind === "heading" ? "reader-paragraph reader-heading" : "reader-paragraph";
    return `<p id="paragraph-${index}" class="${className}">${renderParagraph(entry, index)}</p>`;
  }).join("");
}

function filteredChapters() {
  const query = state.search.trim().toLowerCase();
  return state.book.chapters.map((chapter, index) => ({ chapter, index }))
    .filter(({ chapter }) => !query || chapter.title.toLowerCase().includes(query));
}

function renderChapterList() {
  const list = document.querySelector("#chapter-list");
  list.replaceChildren(...filteredChapters().map(({ chapter, index }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chapter-button ${index === state.chapterIndex ? "active" : ""}`;
    button.dataset.chapterIndex = String(index);
    button.title = chapter.title;
    button.textContent = chapter.title;
    button.addEventListener("click", () => openChapter(index));
    return button;
  }));
}

function scrollToChapterAnchor(fragment) {
  const scroller = document.querySelector("#reader-scroll");
  if (!fragment) {
    scroller.scrollTop = 0;
    return;
  }
  let decoded = fragment.replace(/^#/, "");
  try { decoded = decodeURIComponent(decoded); } catch { /* Keep the literal EPUB anchor. */ }
  const paragraphIndex = state.paragraphs.findIndex((entry) => entry?.anchors?.includes(decoded));
  const target = paragraphIndex >= 0 ? document.querySelector(`#paragraph-${paragraphIndex}`) : null;
  if (target) target.scrollIntoView({ block: "start" });
  else scroller.scrollTop = 0;
}

async function openChapter(index, fragment = "") {
  if (!state.book?.chapters[index]) return;
  state.chapterIndex = index;
  localStorage.setItem(`wordnov-pages-last-chapter:${state.manifest.book.sha256}`, String(index));
  renderChapterList();
  setStatus(`正在读取：${state.book.chapters[index].title}`);
  state.paragraphs = await state.book.chapters[index].load();
  const cache = state.cacheByChapter.get(index);
  state.mixedByParagraph = new Map(cache?.mixedByParagraph || []);
  renderReader();
  const replacementCount = [...state.mixedByParagraph.values()].reduce((sum, items) => sum + items.length, 0);
  const suffix = cache
    ? ` · 已生成 ${cache.completedCount}/${cache.totalCount} 段，显示 ${replacementCount} 处双语替换`
    : " · 本章暂未生成双语内容，显示原文";
  setStatus(`${state.book.chapters[index].title}${suffix}`, "success");
  requestAnimationFrame(() => scrollToChapterAnchor(fragment));
}

function toggleMixedWord(event) {
  const word = event.target.closest(".mixed-word");
  if (!word) return false;
  const showSource = word.dataset.showing !== "source";
  word.dataset.showing = showSource ? "source" : "english";
  word.textContent = showSource ? word.dataset.source : word.dataset.english;
  word.classList.toggle("showing-source", showSource);
  word.setAttribute("aria-pressed", String(showSource));
  word.setAttribute("aria-label", showSource
    ? `${word.dataset.source}，点击显示英文`
    : `${word.dataset.english}，点击显示原文`);
  word.title = showSource ? "点击显示英文" : "点击显示原文";
  return true;
}

async function handleReaderClick(event) {
  if (toggleMixedWord(event)) return;
  const link = event.target.closest("[data-epub-href]");
  if (!link) return;
  event.preventDefault();
  const destination = state.book.resolveLink(state.chapterIndex, link.dataset.epubHref);
  if (!destination) {
    setStatus("这条 EPUB 链接无法定位。", "warning");
    return;
  }
  if (destination.external) {
    window.open(destination.url, "_blank", "noopener,noreferrer");
    return;
  }
  await openChapter(destination.index, destination.fragment);
}

function renderShell() {
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark">词</span>
          <div><strong>词间阅读器</strong><small>双语静态阅读版</small></div>
        </div>
        <div id="book-meta" class="book-meta">正在加载书籍……</div>
        <input id="chapter-search" class="chapter-search" placeholder="搜索章节，例如：卷二十一">
        <nav id="chapter-list" class="chapter-list" aria-label="章节目录"></nav>
        <div class="release-info">
          <strong>已发布内容</strong>
          <span id="release-stats">正在读取……</span>
          <small id="release-time"></small>
        </div>
      </aside>
      <main class="main">
        <header class="toolbar">
          <span>点击英文可切换回原文，再点一次恢复英文</span>
          <span class="static-badge">只读版 · 不连接 AI</span>
        </header>
        <div id="status" class="status">正在加载发布数据……</div>
        <div id="reader-scroll" class="reader-scroll">
          <article id="reader" class="reader">
            <div class="empty-state"><h1>正在打开电子书</h1><p>首次加载 EPUB 可能需要几秒钟。</p></div>
          </article>
        </div>
      </main>
    </div>`;
  document.querySelector("#chapter-search").addEventListener("input", (event) => {
    state.search = event.target.value;
    renderChapterList();
  });
  document.querySelector("#reader").addEventListener("click", handleReaderClick);
}

async function bootstrap() {
  renderShell();
  try {
    const manifestResponse = await fetch("./library/manifest.json", { cache: "no-cache" });
    if (!manifestResponse.ok) throw new Error(`发布清单读取失败（${manifestResponse.status}）`);
    state.manifest = await manifestResponse.json();
    const bookResponse = await fetch(`./${state.manifest.book.asset}`, { cache: "force-cache" });
    if (!bookResponse.ok) throw new Error(`书籍文件读取失败（${bookResponse.status}）`);
    const blob = await bookResponse.blob();
    const extension = state.manifest.book.format === "TXT" ? ".txt" : ".epub";
    state.book = await loadBook(new File([blob], `published-book${extension}`, { type: blob.type }));
    state.cacheByChapter = new Map(state.manifest.chapters.map((chapter) => [chapter.chapterIndex, chapter]));
    document.title = `${state.manifest.book.title} · 词间阅读器`;
    document.querySelector("#book-meta").textContent = `${state.manifest.book.title} · ${state.book.chapters.length} 个章节`;
    const stats = state.manifest.stats;
    document.querySelector("#release-stats").textContent = `${stats.cachedChapters} 个章节有生成记录 · ${stats.replacements} 处双语替换`;
    document.querySelector("#release-time").textContent = `更新于 ${new Date(state.manifest.exportedAt).toLocaleString("zh-CN")}`;
    const saved = Number(localStorage.getItem(`wordnov-pages-last-chapter:${state.manifest.book.sha256}`));
    await openChapter(Number.isInteger(saved) && state.book.chapters[saved] ? saved : 0);
  } catch (error) {
    setStatus(`静态阅读版加载失败：${error.message}`, "error");
    document.querySelector("#reader").innerHTML = `<div class="empty-state"><h1>无法打开阅读版</h1><p>请确认 library/manifest.json 与书籍文件已经生成并发布。</p></div>`;
  }
}

bootstrap();
