const timestamp = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;

export function isChapterRecord(value) {
  return value && Array.isArray(value.mixedByParagraph) && value.mixedByParagraph.every((entry) =>
    Array.isArray(entry) && Number.isInteger(Number(entry[0])) && Number(entry[0]) >= 0 && Array.isArray(entry[1]));
}

// Compare each paragraph's generation time, never a later chapter read/checkpoint time.
export function mergeSharedChapter(records, { bookId, chapterIndex }) {
  const selected = new Map();
  let totalCount = 0;
  const ordered = records.filter(({ value }) => isChapterRecord(value)).sort((a, b) =>
    timestamp(a.value.updatedAt || a.value.createdAt) - timestamp(b.value.updatedAt || b.value.createdAt)
      || String(a.key).localeCompare(String(b.key)));
  for (const { value, key } of ordered) {
    const paragraphMeta = new Map(value.paragraphMeta || []);
    const diagnostics = new Map(value.diagnosticsByParagraph || []);
    totalCount = Math.max(totalCount, Number(value.totalCount) || value.mixedByParagraph.length);
    const legacyTime = timestamp(value.updatedAt || value.createdAt);
    for (const [rawId, replacements] of value.mixedByParagraph) {
      const id = Number(rawId);
      const existingMeta = paragraphMeta.get(id) || paragraphMeta.get(String(id));
      const meta = existingMeta || { generatedAt: legacyTime, model: value.model || "unknown",
        thinking: value.thinking || "legacy-default", level: value.level,
        density: value.density, promptVersion: value.promptVersion, legacyKey: key };
      const generatedAt = timestamp(meta.generatedAt);
      const previous = selected.get(id);
      if (!previous || generatedAt >= timestamp(previous.meta.generatedAt)) {
        selected.set(id, { replacements, meta: { ...meta, generatedAt }, diagnostics: diagnostics.get(id) || diagnostics.get(String(id)) });
      }
    }
  }
  const entries = [...selected.entries()].sort((a, b) => a[0] - b[0]);
  totalCount = Math.max(totalCount, entries.length);
  return { schemaVersion: 3, bookId, chapterIndex, shared: true,
    updatedAt: Math.max(0, ...entries.map(([, item]) => item.meta.generatedAt)),
    mixedByParagraph: entries.map(([id, item]) => [id, item.replacements]),
    paragraphMeta: entries.map(([id, item]) => [id, item.meta]),
    diagnosticsByParagraph: entries.filter(([, item]) => item.diagnostics).map(([id, item]) => [id, item.diagnostics]),
    completedCount: entries.length, totalCount, complete: entries.length === totalCount,
    summary: { acceptedCount: entries.reduce((sum, [, item]) => sum + item.replacements.length, 0) } };
}
