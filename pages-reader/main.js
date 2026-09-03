import "./styles.css";
import { loadBook } from "../src/book-loader.js";
import { renderMixedHtml } from "../src/mixed-renderer.js";
import { findPublishedMatches, normalizePublishedSearchQuery } from "./search-index.js";

const app = document.querySelector("#app");
const state = {
  manifest: null,
  book: null,
  chapterIndex: 0,
  paragraphs: [],
  mixedByParagraph: new Map(),
  cacheByChapter: new Map(),
  chapterParagraphs: new Map(),
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
    button.addEventListener("click", async () => {
      await openChapter(index);
      setSidebarOpen(false);
    });
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

function scrollToParagraph(index) {
  const target = document.querySelector(`#paragraph-${index}`);
  if (target) target.scrollIntoView({ block: "center" });
}

async function loadChapterParagraphs(index) {
  if (!state.chapterParagraphs.has(index)) {
    state.chapterParagraphs.set(index, await state.book.chapters[index].load());
  }
  return state.chapterParagraphs.get(index);
}

async function openChapter(index, fragment = "", paragraphIndex = null) {
  if (!state.book?.chapters[index]) return;
  state.chapterIndex = index;
  localStorage.setItem(`wordnov-pages-last-chapter:${state.manifest.book.sha256}`, String(index));
  renderChapterList();
  setStatus(`正在读取：${state.book.chapters[index].title}`);
  state.paragraphs = await loadChapterParagraphs(index);
  const cache = state.cacheByChapter.get(index);
  state.mixedByParagraph = new Map(cache?.mixedByParagraph || []);
  renderReader();
  const replacementCount = [...state.mixedByParagraph.values()].reduce((sum, items) => sum + items.length, 0);
  const suffix = cache
    ? ` · 已生成 ${cache.completedCount}/${cache.totalCount} 段，显示 ${replacementCount} 处双语替换`
    : " · 本章暂未生成双语内容，显示原文";
  setStatus(`${state.book.chapters[index].title}${suffix}`, "success");
  requestAnimationFrame(() => {
    if (Number.isInteger(paragraphIndex)) scrollToParagraph(paragraphIndex);
    else scrollToChapterAnchor(fragment);
  });
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

function setSidebarOpen(open) {
  const shell = document.querySelector(".app-shell");
  const toggle = document.querySelector("#sidebar-toggle");
  const sidebar = document.querySelector("#sidebar");
  if (!shell || !toggle || !sidebar) return;
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  const drawerOpen = mobile && open;
  if (mobile && !drawerOpen && sidebar.contains(document.activeElement)) {
    toggle.focus({ preventScroll: true });
  }
  shell.classList.toggle("sidebar-open", drawerOpen);
  toggle.setAttribute("aria-expanded", String(drawerOpen));
  sidebar.inert = mobile && !drawerOpen;
  if (mobile) sidebar.setAttribute("aria-hidden", String(!drawerOpen));
  else sidebar.removeAttribute("aria-hidden");
}

function setSearchOpen(open) {
  const overlay = document.querySelector("#word-search-overlay");
  if (!overlay) return;
  overlay.hidden = !open;
  document.querySelector("#word-search-open")?.setAttribute("aria-expanded", String(open));
  if (open) requestAnimationFrame(() => document.querySelector("#word-search-input")?.focus());
}

function createSearchContext(match, paragraph, query) {
  const cache = state.cacheByChapter.get(match.chapterIndex);
  const replacements = new Map(cache?.mixedByParagraph || []).get(match.paragraphIndex) || [];
  const context = document.createElement("p");
  context.className = "search-result-context";
  context.innerHTML = renderMixedHtml(paragraphText(paragraph), replacements);
  context.querySelectorAll(".mixed-word").forEach((button) => {
    const english = normalizePublishedSearchQuery(button.dataset.english);
    const source = normalizePublishedSearchQuery(button.dataset.source);
    const token = document.createElement("span");
    token.className = "search-token";
    const matchesEnglish = english.includes(query);
    const matchesSource = source.includes(query);
    token.textContent = matchesSource && !matchesEnglish ? button.dataset.source : button.dataset.english;
    token.classList.toggle("search-hit", matchesEnglish || matchesSource);
    button.replaceWith(token);
  });
  return context;
}

function createSearchResult(match, paragraph, query) {
  const result = document.createElement("article");
  result.className = "search-result";
  result.tabIndex = 0;
  result.setAttribute("role", "button");
  const title = document.createElement("h3");
  title.textContent = state.book.chapters[match.chapterIndex]?.title || `第 ${match.chapterIndex + 1} 节`;
  const position = document.createElement("small");
  position.textContent = `第 ${match.paragraphIndex + 1} 段 · ${match.items.length} 处匹配`;
  result.append(title, position, createSearchContext(match, paragraph, query));
  const open = async () => {
    setSearchOpen(false);
    await openChapter(match.chapterIndex, "", match.paragraphIndex);
  };
  result.addEventListener("click", open);
  result.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
  return result;
}

async function runPublishedSearch() {
  const input = document.querySelector("#word-search-input");
  const submit = document.querySelector("#word-search-submit");
  const summary = document.querySelector("#word-search-summary");
  const resultsNode = document.querySelector("#word-search-results");
  const rawQuery = input.value.trim();
  if (!rawQuery) {
    summary.textContent = "请输入要查找的英文词、短语或对应中文。";
    resultsNode.replaceChildren();
    return;
  }
  if (/^[A-Za-z]$/.test(rawQuery)) {
    summary.textContent = "单个英文字母结果过多，请至少输入两个字母。";
    resultsNode.replaceChildren();
    return;
  }
  submit.disabled = true;
  resultsNode.replaceChildren();
  try {
    const found = findPublishedMatches(state.manifest.chapters, rawQuery);
    if (!found.totalParagraphs) {
      summary.textContent = `没有找到“${rawQuery}”。搜索范围仅包括已发布的双语替换。`;
      return;
    }
    summary.textContent = `正在整理 ${found.totalParagraphs} 个段落中的 ${found.totalOccurrences} 处匹配……`;
    for (const match of found.matches) {
      const paragraphs = await loadChapterParagraphs(match.chapterIndex);
      const paragraph = paragraphs[match.paragraphIndex];
      if (paragraph) resultsNode.append(createSearchResult(match, paragraph, found.query));
    }
    const limitNote = found.truncated ? `；为保证手机流畅，仅显示前 ${found.matches.length} 个段落` : "";
    summary.textContent = `找到 ${found.totalParagraphs} 个段落、${found.totalOccurrences} 处匹配${limitNote}`;
  } catch (error) {
    summary.textContent = `搜索失败：${error.message}`;
  } finally {
    submit.disabled = false;
  }
}

function renderShell() {
  app.innerHTML = `
    <div class="app-shell">
      <button id="sidebar-backdrop" class="sidebar-backdrop" type="button" aria-label="关闭章节目录"></button>
      <aside id="sidebar" class="sidebar" aria-label="章节目录">
        <div class="brand">
          <span class="brand-mark">词</span>
          <div><strong>词间阅读器</strong><small>双语静态阅读版</small></div>
          <button id="sidebar-close" class="sidebar-close" type="button" aria-label="关闭章节目录">×</button>
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
          <div class="toolbar-actions">
            <button id="sidebar-toggle" class="toolbar-button mobile-menu-button" type="button" aria-controls="sidebar" aria-expanded="false">☰ 目录</button>
            <button id="word-search-open" class="toolbar-button" type="button" aria-controls="word-search-overlay" aria-expanded="false" disabled>⌕ 搜索词</button>
          </div>
          <span class="toolbar-instruction">点击英文可切换回原文，再点一次恢复英文</span>
          <span class="static-badge">只读版 · 不连接 AI</span>
        </header>
        <div id="status" class="status">正在加载发布数据……</div>
        <div id="reader-scroll" class="reader-scroll">
          <article id="reader" class="reader">
            <div class="empty-state"><h1>正在打开电子书</h1><p>首次加载 EPUB 可能需要几秒钟。</p></div>
          </article>
        </div>
      </main>
      <div id="word-search-overlay" class="search-overlay" hidden>
        <section class="search-dialog" role="dialog" aria-modal="true" aria-labelledby="word-search-title">
          <header class="search-header">
            <div><h2 id="word-search-title">搜索已发布双语内容</h2><small>在所有已生成替换中查找英文或对应中文，无需服务器。</small></div>
            <button id="word-search-close" class="dialog-close" type="button" aria-label="关闭搜索">×</button>
          </header>
          <form id="word-search-form" class="search-form">
            <input id="word-search-input" type="search" maxlength="80" autocomplete="off" placeholder="例如：feared、老气横秋" aria-label="搜索双语词">
            <button id="word-search-submit" type="submit">搜索</button>
          </form>
          <div id="word-search-summary" class="search-summary">输入词语后按回车搜索。</div>
          <div id="word-search-results" class="search-results"></div>
        </section>
      </div>
    </div>`;
  document.querySelector("#chapter-search").addEventListener("input", (event) => {
    state.search = event.target.value;
    renderChapterList();
  });
  document.querySelector("#reader").addEventListener("click", handleReaderClick);
  document.querySelector("#sidebar-toggle").addEventListener("click", () => setSidebarOpen(true));
  document.querySelector("#sidebar-close").addEventListener("click", () => setSidebarOpen(false));
  document.querySelector("#sidebar-backdrop").addEventListener("click", () => setSidebarOpen(false));
  document.querySelector("#word-search-open").addEventListener("click", () => setSearchOpen(true));
  document.querySelector("#word-search-close").addEventListener("click", () => setSearchOpen(false));
  document.querySelector("#word-search-overlay").addEventListener("click", (event) => {
    if (event.target.id === "word-search-overlay") setSearchOpen(false);
  });
  document.querySelector("#word-search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    runPublishedSearch();
  });
  setSidebarOpen(false);
  window.addEventListener("resize", () => setSidebarOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!document.querySelector("#word-search-overlay").hidden) setSearchOpen(false);
    else setSidebarOpen(false);
  });
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
    document.querySelector("#word-search-open").disabled = false;
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
