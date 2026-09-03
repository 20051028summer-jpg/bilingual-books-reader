import { normalizeConcurrency } from "./request-settings.js";
import { mergeSharedChapter } from "./shared-chapter.js";

const hanCount = (value) => (String(value || "").match(/\p{Script=Han}/gu) || []).length;

export async function runChapterTranslation({ paragraphs, initial, metadata, concurrency = 3,
  requestBatch, persist, onProgress = () => {}, shouldStop = () => false,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, random = Math.random }) {
  const limit = normalizeConcurrency(concurrency);
  const eligible = new Map(paragraphs.map((paragraph) => [Number(paragraph.id), paragraph]));
  let results = new Map((initial?.mixedByParagraph || []).filter(([id, value]) => eligible.has(Number(id)) && Array.isArray(value))
    .map(([id, value]) => [Number(id), value]));
  let diagnostics = new Map(initial?.diagnosticsByParagraph || []);
  let paragraphMeta = new Map(mergeSharedChapter([{ key: "initial", value: initial }], metadata).paragraphMeta);
  let savedSnapshot;
  let active = 0;
  let retries = 0;
  let error = null;
  let stopped = false;
  let cursor = 0;
  let cooldownUntil = 0;
  let commitTail = Promise.resolve();
  const pending = paragraphs.filter((paragraph) => !results.has(Number(paragraph.id)));
  const batches = [];
  for (let index = 0; index < pending.length; index += 2) batches.push(pending.slice(index, index + 2));

  function snapshot(next = results, nextDiagnostics = diagnostics, nextMeta = paragraphMeta) {
    let acceptedCount = 0;
    let sourceCharacterCount = 0;
    let changedSourceCharacterCount = 0;
    let supplementalParagraphCount = 0;
    for (const [id, replacements] of next) {
      const detail = nextDiagnostics.get(id);
      acceptedCount += replacements.length;
      sourceCharacterCount += detail?.sourceCharacterCount ?? hanCount(eligible.get(id)?.text);
      changedSourceCharacterCount += detail?.changedSourceCharacterCount ?? replacements.reduce((sum, item) => sum + hanCount(item.source), 0);
      if (detail?.supplementalPassUsed) supplementalParagraphCount++;
    }
    return { ...metadata, schemaVersion: 3, shared: true, updatedAt: now(),
      mixedByParagraph: [...next.entries()].sort((a, b) => a[0] - b[0]),
      diagnosticsByParagraph: [...nextDiagnostics.entries()], completedCount: next.size,
      paragraphMeta: [...nextMeta.entries()],
      totalCount: paragraphs.length, complete: next.size === paragraphs.length,
      summary: { acceptedCount, sourceCharacterCount, changedSourceCharacterCount,
        achievedDensity: sourceCharacterCount ? Number((100 * changedSourceCharacterCount / sourceCharacterCount).toFixed(1)) : 0,
        targetDensity: metadata.targetDensity, supplementalParagraphCount } };
  }
  function report(extra = {}) {
    onProgress({ completed: results.size, total: paragraphs.length, active, retries, concurrency: limit,
      snapshot: savedSnapshot, ...extra });
  }
  function halt(reason) { stopped = true; error ||= reason; }
  function commit(items) {
    const task = commitTail.then(async () => {
      const next = new Map(results);
      const nextDiagnostics = new Map(diagnostics);
      const nextMeta = new Map(paragraphMeta);
      for (const item of items) {
        next.set(Number(item.id), item.replacements);
        if (item.diagnostics) nextDiagnostics.set(Number(item.id), item.diagnostics);
        nextMeta.set(Number(item.id), { generatedAt: Math.max(now(), Number(nextMeta.get(Number(item.id))?.generatedAt || 0) + 1),
          model: metadata.model, thinking: metadata.thinking, level: metadata.level,
          density: metadata.density, promptVersion: metadata.promptVersion });
      }
      const checkpoint = snapshot(next, nextDiagnostics, nextMeta);
      try { await persist(checkpoint); }
      catch (cause) { throw new Error(`本地进度保存失败，已停止提交新请求：${cause.message}`); }
      results = next;
      diagnostics = nextDiagnostics;
      paragraphMeta = nextMeta;
      savedSnapshot = checkpoint;
      report();
    });
    commitTail = task.catch(() => {});
    return task;
  }
  async function waitCooldown() {
    while (now() < cooldownUntil && !stopped && !shouldStop()) {
      report({ waiting: true });
      await sleep(Math.min(1000, cooldownUntil - now()));
    }
  }
  async function worker() {
    while (!stopped && !shouldStop()) {
      await waitCooldown();
      if (stopped || shouldStop()) break;
      const batch = batches[cursor++];
      if (!batch) break;
      active++;
      report();
      try {
        let response;
        for (let attempt = 0; ; attempt++) {
          try { response = await requestBatch(batch); break; }
          catch (failure) {
            if (!failure.retryable || attempt >= 2 || stopped || shouldStop() || failure.retryAfterMs > 60000) throw failure;
            retries++;
            cooldownUntil = Math.max(cooldownUntil, now() + Math.max(failure.retryAfterMs || 0,
              3000 * (2 ** attempt) + Math.floor(random() * 1000)));
            await waitCooldown();
            if (stopped || shouldStop()) return;
          }
        }
        if (!Array.isArray(response?.paragraphs) || batch.some((paragraph) =>
          !response.paragraphs.some((item) => String(item.id) === String(paragraph.id) && Array.isArray(item.replacements)))) {
          throw new Error("API 返回缺少段落结果，本批未标记完成");
        }
        if (response.haltError) halt(new Error(`补选中断，首轮结果已保留：${response.haltError.error}`));
        await commit(response.paragraphs.filter((item) => batch.some((p) => String(p.id) === String(item.id))));
      } catch (failure) { halt(failure); }
      finally { active--; report(); }
    }
  }

  // Check persistence before spending tokens, and retain already completed empty results.
  await commit([]);
  await Promise.all(Array.from({ length: Math.min(limit, batches.length) }, () => worker()));
  await commitTail;
  return { snapshot: savedSnapshot, error, paused: shouldStop() && results.size < paragraphs.length, retries };
}
