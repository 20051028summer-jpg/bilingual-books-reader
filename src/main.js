import "./styles.css";
import { loadBook } from "./book-loader.js";
import { exportPagesReader, getApiStatus, mixParagraphBatch, saveModelConfig } from "./api.js";
import { chapterCacheKeys, readModelChapterCache } from "./cache-keys.js";
import { runChapterTranslation } from "./chapter-runner.js";
import { THINKING_LABELS, thinkingCapabilities, normalizeThinking } from "./request-settings.js";
import {
  clearAllStoredData,
  getStorageEstimate,
  listBookChapterCaches,
  migrateBookCache,
  readCachedChapter,
  readLastBook,
  writeCachedChapter,
  writeLastBook,
} from "./storage.js";
import { renderMixedHtml } from "./mixed-renderer.js";
import { DENSITY_PERCENTAGES } from "./settings.js";

const app = document.querySelector("#app");

const state = {
  book: null,
  sourceFile: null,
  chapterIndex: 0,
  paragraphs: [],
  mixedByParagraph: new Map(),
  apiStatus: null,
  search: "",
  generating: false,
  savingConfig: false,
  pauseRequested: false,
};

function paragraphText(entry) {
  return typeof entry === "string" ? entry : entry?.text || "";
}

function setStatus(message, kind = "info") {
  const node = document.querySelector("#status");
  if (!node) return;
  node.textContent = message;
  node.dataset.kind = kind;
}

function setProgress(done, total) {
  const node = document.querySelector("#progress");
  if (!node) return;
  node.hidden = total <= 0;
  node.value = done;
  node.max = Math.max(total, 1);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function renderParagraph(entry, index) {
  const mixed = state.mixedByParagraph.get(index);
  if (mixed) return renderMixedHtml(paragraphText(entry), mixed);
  if (entry?.html) return entry.html;
  const node = document.createElement("span");
  node.textContent = paragraphText(entry);
  return node.innerHTML;
}

function renderReader() {
  const reader = document.querySelector("#reader");
  if (!reader) return;
  reader.innerHTML = state.paragraphs
    .map((entry, index) => {
      const className = entry?.kind === "heading" ? "reader-paragraph reader-heading" : "reader-paragraph";
      return `<p id="paragraph-${index}" class="${className}">${renderParagraph(entry, index)}</p>`;
    })
    .join("");
}

function filteredChapters() {
  if (!state.book) return [];
  const query = state.search.trim().toLowerCase();
  return state.book.chapters
    .map((chapter, index) => ({ chapter, index }))
    .filter(({ chapter }) => !query || chapter.title.toLowerCase().includes(query));
}

function renderChapterList() {
  const list = document.querySelector("#chapter-list");
  if (!list) return;
  const entries = filteredChapters();
  list.innerHTML = entries
    .map(
      ({ chapter, index }) =>
        `<button class="chapter-button ${index === state.chapterIndex ? "active" : ""}" data-chapter-index="${index}" title="${chapter.title.replaceAll('"', "&quot;")}">${chapter.title}</button>`,
    )
    .join("");
  list.querySelectorAll("[data-chapter-index]").forEach((button) => {
    button.addEventListener("click", () => openChapter(Number(button.dataset.chapterIndex)));
  });
}

function cacheKeysForCurrentChapter() {
  if (!state.book) return null;
  return chapterCacheKeys({ bookId: state.book.id, chapterIndex: state.chapterIndex });
}

function readCurrentChapterCache() {
  return readModelChapterCache(readCachedChapter, cacheKeysForCurrentChapter());
}

function scrollToChapterAnchor(fragment) {
  const scroller = document.querySelector("#reader-scroll");
  if (!scroller) return;
  if (!fragment) {
    scroller.scrollTop = 0;
    return;
  }
  const decoded = decodeURIComponent(fragment.replace(/^#/, ""));
  const paragraphIndex = state.paragraphs.findIndex((entry) => entry?.anchors?.includes(decoded));
  const target = paragraphIndex >= 0 ? document.querySelector(`#paragraph-${paragraphIndex}`) : null;
  if (target) target.scrollIntoView({ block: "start" });
  else scroller.scrollTop = 0;
}

async function openChapter(index, fragment = "") {
  if (state.generating || state.savingConfig) return;
  if (!state.book || !state.book.chapters[index]) return;
  state.chapterIndex = index;
  state.mixedByParagraph.clear();
  localStorage.setItem(`wordnov-last-chapter:${state.book.id}`, String(index));
  renderChapterList();
  setStatus(`正在读取：${state.book.chapters[index].title}`);
  state.paragraphs = await state.book.chapters[index].load();
  const cached = await readCurrentChapterCache();
  if (cached?.mixedByParagraph) {
    state.mixedByParagraph = new Map(cached.mixedByParagraph);
    const progress = cached.complete === false ? `（已完成 ${cached.completedCount}/${cached.totalCount} 段，可继续生成）` : "";
    setStatus(`已从本地缓存恢复：${state.book.chapters[index].title}${progress}`, "success");
  } else {
    setStatus(`已打开：${state.book.chapters[index].title}`, "success");
  }
  renderReader();
  requestAnimationFrame(() => scrollToChapterAnchor(fragment));
}

async function refreshStorageSummary() {
  const node = document.querySelector("#storage-summary");
  if (!node) return;
  const estimate = await getStorageEstimate();
  node.textContent = estimate
    ? `浏览器已用 ${formatBytes(estimate.usage)} / 可用配额 ${formatBytes(estimate.quota)}`
    : "本地存储用量由浏览器管理";
}

async function importBook(file, { persist = true, restored = false } = {}) {
  setStatus(restored ? "正在恢复上次阅读的书……" : `正在导入 ${file.name}……`);
  const book = await loadBook(file);
  await migrateBookCache(book.id);
  state.book = book;
  state.sourceFile = file;
  state.search = "";
  state.mixedByParagraph.clear();
  const meta = document.querySelector("#book-meta");
  if (meta) meta.textContent = `${book.title} · ${book.chapters.length} 个章节`;
  const search = document.querySelector("#chapter-search");
  if (search) search.value = "";
  if (persist) {
    try {
      await writeLastBook(file);
    } catch (error) {
      setStatus(`书已打开，但浏览器未能保存原书：${error.message}`, "warning");
    }
  }
  const savedIndex = Number(localStorage.getItem(`wordnov-last-chapter:${book.id}`));
  await openChapter(Number.isInteger(savedIndex) && book.chapters[savedIndex] ? savedIndex : 0);
  await refreshStorageSummary();
}

async function handlePagesExport() {
  if (!state.book || !state.sourceFile || state.generating || state.savingConfig) {
    setStatus("请先导入或恢复一本书，并等待当前任务结束。", "warning");
    return;
  }
  const button = document.querySelector("#export-pages");
  const preview = document.querySelector("#pages-preview-link");
  button.disabled = true;
  preview.hidden = true;
  try {
    setStatus("正在汇总已生成内容并构建静态阅读版……");
    const caches = await listBookChapterCaches(state.book.id);
    const result = await exportPagesReader(state.sourceFile, {
      book: {
        id: state.book.id,
        title: state.book.title,
        format: state.book.format,
        chapterCount: state.book.chapters.length,
      },
      chapters: caches.map((cache) => ({
        chapterIndex: cache.chapterIndex,
        mixedByParagraph: cache.mixedByParagraph,
        completedCount: cache.completedCount,
        totalCount: cache.totalCount,
      })),
    });
    const stats = result.stats || {};
    preview.href = result.previewUrl || "/pages-preview/";
    preview.hidden = false;
    setStatus(
      `静态阅读版已更新：${stats.cachedChapters || 0} 个章节、${stats.replacements || 0} 处替换。点击左侧“预览阅读版”检查。`,
      "success",
    );
  } catch (error) {
    setStatus(`静态阅读版更新失败：${error.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

async function restoreLastBook() {
  try {
    const stored = await readLastBook();
    if (!stored?.blob || !stored?.name) return;
    const file = new File([stored.blob], stored.name, {
      type: stored.type || stored.blob.type,
      lastModified: stored.lastModified || Date.now(),
    });
    await importBook(file, { persist: false, restored: true });
  } catch (error) {
    setStatus(`未能恢复上次阅读：${error.message}`, "warning");
  }
}

async function generateMixedChapter() {
  if (!state.book || state.generating || state.savingConfig) return;
  if (!state.apiStatus?.configured) {
    setStatus("请先在左侧“API 设置”中保存 DashScope API Key。", "warning");
    return;
  }
  const eligible = state.paragraphs
    .map((entry, index) => ({ id: index, text: paragraphText(entry) }))
    .filter((item) => item.text.trim().length >= 12);
  if (!eligible.length) {
    setStatus("本章没有适合处理的段落。", "warning");
    return;
  }

  state.generating = true;
  state.pauseRequested = false;
  const model = state.apiStatus.model;
  const thinking = state.apiStatus.thinking || "disabled";
  const concurrency = state.apiStatus.concurrency || 3;
  const promptVersion = state.apiStatus.promptVersion;
  const cacheKey = cacheKeysForCurrentChapter().current;
  const level = document.querySelector("#level").value;
  const density = document.querySelector("#density").value;
  setConfigDisabled(true);
  for (const id of ["level", "density", "book-file", "clear-cache"]) document.getElementById(id).disabled = true;
  document.querySelector("#generate").disabled = true;
  document.querySelector("#pause-generation").hidden = false;
  document.querySelector("#pause-generation").disabled = false;
  setProgress(0, eligible.length);
  try {
    const execute = async () => {
      const initial = await readCurrentChapterCache();
      let renderedSnapshot;
      return runChapterTranslation({ paragraphs: eligible, initial,
        metadata: { bookId: state.book.id, chapterIndex: state.chapterIndex,
          model, thinking, promptVersion, level, density, targetDensity: DENSITY_PERCENTAGES[density] },
        concurrency,
        requestBatch: (batch) => mixParagraphBatch(batch, { model, thinking, level, density, protectedTerms: state.book.protectedTerms ?? [] }),
        persist: (checkpoint) => writeCachedChapter(cacheKey, checkpoint),
        shouldStop: () => state.pauseRequested,
        onProgress: ({ completed, total, active, retries, snapshot, waiting }) => {
          if (snapshot && snapshot !== renderedSnapshot) {
            state.mixedByParagraph = new Map(snapshot.mixedByParagraph);
            renderReader();
            renderedSnapshot = snapshot;
          }
          setProgress(completed, total);
          const prefix = state.pauseRequested ? "正在暂停，等待已发出的请求保存" : waiting ? "触发限流，等待退避重试" : "正在并行生成";
          setStatus(`${prefix} · 已保存 ${completed}/${total} 段 · 进行中 ${active}/${concurrency} 批${retries ? ` · 限流重试 ${retries} 次` : ""}`);
        },
      });
    };
    // Avoid paying twice for the same chapter when two tabs generate simultaneously.
    const result = navigator.locks
      ? await navigator.locks.request(`wordnov-generation:${cacheKey}`, { ifAvailable: true }, (lock) => {
        if (!lock) throw new Error("另一个页面正在生成本章，请等待其完成后再续译");
        return execute();
      }) : await execute();
    await refreshStorageSummary();
    const saved = result.snapshot;
    if (result.error || result.paused) {
      setStatus(`${result.error ? `已停止：${result.error.message}` : "已暂停"}；已保存 ${saved.completedCount}/${saved.totalCount} 段，${saved.complete ? "本章首轮结果已保存" : "下次点击“AI 生成 / 继续本章”只处理未完成段落"}。`, "warning");
    } else {
      const { acceptedCount, achievedDensity, targetDensity } = saved.summary;
      setStatus(`本章完成：替换 ${acceptedCount} 处，实际覆盖 ${achievedDensity}%（目标 ${targetDensity}%）；${saved.completedCount} 段均已缓存，再次点击不会重复调用。`, achievedDensity < targetDensity * 0.6 ? "warning" : "success");
    }
  } catch (error) {
    setStatus(`生成停止：${error.message}。已成功保存的段落会在下次续译时跳过。`, "error");
  } finally {
    state.generating = false;
    setConfigDisabled(false);
    for (const id of ["level", "density", "book-file", "clear-cache"]) document.getElementById(id).disabled = false;
    document.querySelector("#generate").disabled = false;
    document.querySelector("#pause-generation").hidden = true;
    setProgress(0, 0);
  }
}

function setConfigDisabled(disabled) {
  for (const node of document.querySelectorAll("#api-form input, #api-form button, #api-form select")) node.disabled = disabled;
}

function updateModelHint() {
  const name = document.querySelector("#api-model").value.trim();
  const saved = state.apiStatus?.savedModels?.includes(name);
  const options = state.apiStatus?.savedSettings?.[name];
  const capability = thinkingCapabilities(name);
  const selector = document.querySelector("#api-thinking");
  selector.replaceChildren(...Object.entries(THINKING_LABELS).map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.disabled = !capability.modes.includes(value);
    option.textContent = label + (value === "disabled" ? "（默认）" : option.disabled ? "（此模型不支持）" : "");
    return option;
  }));
  selector.value = normalizeThinking(options?.thinking);
  document.querySelector("#thinking-hint").textContent = capability.hint;
  document.querySelector("#api-concurrency").value = String(options?.concurrency || 3);
  document.querySelector("#api-key").placeholder = saved ? "已保存 Key；留空自动沿用" : "首次使用此模型，请填写 DashScope API Key";
  document.querySelector("#model-key-hint").textContent = saved
    ? "此模型的 Key 已保存在本机，留空点击“保存并切换”即可使用。"
    : "新模型首次填写 Key；不会覆盖其他模型已保存的 Key。";
}

function renderModelConfig() {
  const status = state.apiStatus;
  document.querySelector("#api-config-state").textContent = status.configured ? `当前 · ${status.model}` : "未配置";
  document.querySelector("#api-model").value = status.model;
  document.querySelector("#saved-models").replaceChildren(...(status.savedModels || []).map((name) => {
    const option = document.createElement("option");
    option.value = name;
    return option;
  }));
  updateModelHint();
}

async function handleSaveModelConfig() {
  if (state.generating || state.savingConfig) return;
  const input = document.querySelector("#api-key");
  const model = document.querySelector("#api-model").value.trim();
  const value = input.value.trim();
  if (!model) {
    setStatus("请输入模型名称。", "warning");
    return;
  }
  state.savingConfig = true;
  setConfigDisabled(true);
  document.querySelector("#generate").disabled = true;
  try {
    const previousKey = state.book ? cacheKeysForCurrentChapter().current : null;
    const status = await saveModelConfig(model, value, {
      thinking: document.querySelector("#api-thinking").value,
      concurrency: Number(document.querySelector("#api-concurrency").value),
    });
    state.apiStatus = status;
    input.value = "";
    renderModelConfig();
    if (state.book && previousKey !== cacheKeysForCurrentChapter().current) {
      state.mixedByParagraph.clear();
      renderReader();
      const cached = await readCurrentChapterCache();
      state.mixedByParagraph = new Map(cached?.mixedByParagraph || []);
      renderReader();
    }
    setStatus(`已保存 ${status.model} · ${THINKING_LABELS[status.thinking]} · ${status.concurrency} 批并行；${value ? "Key 已保存" : "沿用已保存的 Key"}，重启后仍会保留。`, "success");
  } catch (error) {
    setStatus(`模型配置失败：${error.message}`, "error");
  } finally {
    state.savingConfig = false;
    setConfigDisabled(false);
    document.querySelector("#generate").disabled = false;
  }
}

async function handleClearCache() {
  if (!window.confirm("清除已保存的原书和全部 AI 换词结果？此操作不会删除你的 EPUB/TXT 原文件。")) return;
  await clearAllStoredData();
  state.mixedByParagraph.clear();
  renderReader();
  await refreshStorageSummary();
  setStatus("浏览器中的原书副本和 AI 结果缓存已清除。", "success");
}

async function handleReaderLink(event) {
  const link = event.target.closest("[data-epub-href]");
  if (!link || !state.book) return;
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

function handleMixedWordToggle(event) {
  const word = event.target.closest(".mixed-word");
  if (!word) return false;
  const showSource = word.dataset.showing !== "source";
  word.dataset.showing = showSource ? "source" : "english";
  word.textContent = showSource ? word.dataset.source : word.dataset.english;
  word.classList.toggle("showing-source", showSource);
  word.setAttribute("aria-pressed", String(showSource));
  word.setAttribute(
    "aria-label",
    showSource
      ? `${word.dataset.source}，点击显示英文`
      : `${word.dataset.english}，点击显示原文`,
  );
  word.title = showSource ? "点击显示英文" : "点击显示原文";
  return true;
}

async function handleReaderClick(event) {
  if (handleMixedWordToggle(event)) return;
  await handleReaderLink(event);
}

function renderApp() {
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark">W</span>
          <div><strong>词间阅读器</strong><small>上下文中英混合阅读</small></div>
        </div>
        <label class="import-button">
          <input id="book-file" type="file" accept=".epub,.txt,text/plain,application/epub+zip">
          导入 EPUB / TXT
        </label>
        <div id="book-meta" class="book-meta">尚未导入书籍<br><small>浏览器只保留最近一本原书副本</small></div>
        <input id="chapter-search" class="chapter-search" placeholder="搜索章节，例如：卷二十一">
        <nav id="chapter-list" class="chapter-list"></nav>
        <div class="sidebar-tools">
          <details class="api-panel">
            <summary>API 设置 <span id="api-config-state">检查中</span></summary>
            <form id="api-form" class="api-form">
              <label for="api-model">模型名称（可手动输入）</label>
              <input id="api-model" class="api-key-input" type="text" list="saved-models" autocomplete="off" spellcheck="false" maxlength="160" placeholder="例如 qwen-flash" required>
              <datalist id="saved-models"></datalist>
              <label for="api-key">API Key（已保存的模型可留空）</label>
              <input id="api-key" class="api-key-input" type="password" autocomplete="off" placeholder="DashScope API Key">
              <small id="model-key-hint"></small>
              <label for="api-thinking">思考强度</label>
              <select id="api-thinking" class="api-key-input">
                <option value="disabled">关闭（默认）</option>
                <option value="low">低</option><option value="medium">中</option>
                <option value="high">高</option><option value="max">最大</option>
              </select>
              <small id="thinking-hint"></small>
              <label for="api-concurrency">并行批数（每批最多 2 段）</label>
              <select id="api-concurrency" class="api-key-input">
                <option value="1">1（串行）</option><option value="2">2</option>
                <option value="3" selected>3（默认）</option><option value="4">4</option>
                <option value="5">5</option><option value="6">6</option>
              </select>
              <small>每批完成立即保存；限流会退避重试，额度不足会停止新请求。</small>
              <button id="save-api-key" class="side-button" type="submit">保存并切换</button>
              <small>Key 按模型保存；每章内容只保留一份，各模型共同续写。同段最新生成结果覆盖旧结果，切换设置不隐藏已有内容。</small>
            </form>
          </details>
          <div class="storage-row">
            <small id="storage-summary">正在计算本地存储……</small>
            <button id="clear-cache" class="text-button">清除缓存</button>
          </div>
          <div class="pages-export-panel">
            <button id="export-pages" class="side-button" type="button">更新 GitHub Pages 阅读版</button>
            <a id="pages-preview-link" class="preview-link" href="/pages-preview/" target="_blank" rel="noopener" hidden>预览阅读版</a>
            <small>只导出原书与已生成结果；静态版不含 AI、API Key 或生成入口。</small>
          </div>
        </div>
      </aside>
      <main class="main">
        <header class="toolbar">
          <label>水平
            <select id="level">
              <option value="cet4">四级</option>
              <option value="cet6" selected>六级</option>
            </select>
          </label>
          <label>密度
            <select id="density">
              <option value="light">低（10%）</option>
              <option value="medium" selected>中（20%）</option>
              <option value="dense">高（40%）</option>
            </select>
          </label>
          <button id="generate" class="generate-button">AI 生成 / 继续本章</button>
          <button id="pause-generation" class="generate-button" hidden>暂停并保存</button>
          <span class="proper-noun-note">人名、地名、机构名、作品名等专名不参与替换</span>
        </header>
        <div id="status" class="status">正在连接本机服务……</div>
        <progress id="progress" class="progress" hidden></progress>
        <div id="reader-scroll" class="reader-scroll">
          <article id="reader" class="reader">
            <div class="empty-state">
              <h1>导入一本书开始阅读</h1>
              <p>保留 EPUB 目录和内部跳转；AI 会按所选等级优先挑选重点单词，并保留少量必要短语。</p>
            </div>
          </article>
        </div>
      </main>
    </div>
  `;

  document.querySelector("#book-file").addEventListener("change", async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    try {
      await importBook(file);
    } catch (error) {
      setStatus(`导入失败：${error.message}`, "error");
    } finally {
      event.target.value = "";
    }
  });
  document.querySelector("#chapter-search").addEventListener("input", (event) => {
    state.search = event.target.value;
    renderChapterList();
  });
  document.querySelector("#generate").addEventListener("click", generateMixedChapter);
  document.querySelector("#pause-generation").addEventListener("click", () => {
    state.pauseRequested = true;
    document.querySelector("#pause-generation").disabled = true;
    setStatus("正在暂停：不再提交新批次，等待进行中的请求返回并保存后即可安全关闭。", "warning");
  });
  window.addEventListener("beforeunload", (event) => {
    if (!state.generating) return;
    event.preventDefault();
    event.returnValue = "";
  });
  for (const id of ["level", "density"]) document.getElementById(id).addEventListener("change", () => {
    if (state.book && !state.generating) openChapter(state.chapterIndex);
  });
  document.querySelector("#api-form").addEventListener("submit", (event) => {
    event.preventDefault();
    handleSaveModelConfig();
  });
  document.querySelector("#api-model").addEventListener("input", () => {
    document.querySelector("#api-key").value = "";
    updateModelHint();
  });
  document.querySelector("#clear-cache").addEventListener("click", handleClearCache);
  document.querySelector("#export-pages").addEventListener("click", handlePagesExport);
  document.querySelector("#reader").addEventListener("click", handleReaderClick);
}

async function bootstrap() {
  renderApp();
  await refreshStorageSummary();
  try {
    state.apiStatus = await getApiStatus();
    renderModelConfig();
    setStatus(
      state.apiStatus.configured
        ? `本机服务已就绪 · ${state.apiStatus.model}`
        : "阅读功能可用；生成混合文本前请在左侧保存 API Key。",
      state.apiStatus.configured ? "success" : "warning",
    );
  } catch (error) {
    setStatus(`本机服务未连接：${error.message}`, "error");
  }
  await restoreLastBook();
}

bootstrap();
