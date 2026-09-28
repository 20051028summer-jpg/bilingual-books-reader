function timestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function isMixedEntry(entry) {
  return Array.isArray(entry)
    && Number.isInteger(Number(entry[0]))
    && Number(entry[0]) >= 0
    && Array.isArray(entry[1]);
}

export function publishedRecordsForBook(bookId, manifest) {
  if (!bookId || manifest?.book?.id !== bookId) {
    return { compatible: false, records: [], reason: "book_mismatch" };
  }

  const records = [];
  for (const chapter of Array.isArray(manifest.chapters) ? manifest.chapters : []) {
    const chapterIndex = Number(chapter?.chapterIndex);
    if (!Number.isInteger(chapterIndex) || chapterIndex < 0) continue;
    if (!Array.isArray(chapter.mixedByParagraph) || !chapter.mixedByParagraph.every(isMixedEntry)) continue;

    const paragraphMeta = Array.isArray(chapter.paragraphMeta)
      ? chapter.paragraphMeta.filter((entry) => Array.isArray(entry) && Number.isInteger(Number(entry[0])))
      : [];
    const generatedTimes = paragraphMeta.map(([, meta]) => timestamp(meta?.generatedAt));
    const completedCount = chapter.mixedByParagraph.length;
    const totalCount = Math.max(completedCount, Number(chapter.totalCount) || 0);
    records.push({
      schemaVersion: 3,
      bookId,
      chapterIndex,
      shared: true,
      updatedAt: Math.max(0, ...generatedTimes),
      mixedByParagraph: chapter.mixedByParagraph,
      paragraphMeta,
      diagnosticsByParagraph: Array.isArray(chapter.diagnosticsByParagraph) ? chapter.diagnosticsByParagraph : [],
      completedCount,
      totalCount,
      complete: completedCount === totalCount,
      summary: {
        acceptedCount: chapter.mixedByParagraph.reduce(
          (sum, [, replacements]) => sum + replacements.length,
          0,
        ),
      },
    });
  }

  return { compatible: true, records, reason: null };
}
