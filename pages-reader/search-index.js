export function normalizePublishedSearchQuery(value) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

export function findPublishedMatches(chapters, value, limit = 120) {
  const query = normalizePublishedSearchQuery(value);
  const matches = [];
  let totalParagraphs = 0;
  let totalOccurrences = 0;
  if (!query) return { query, matches, totalParagraphs, totalOccurrences, truncated: false };

  for (const chapter of Array.isArray(chapters) ? chapters : []) {
    for (const entry of Array.isArray(chapter?.mixedByParagraph) ? chapter.mixedByParagraph : []) {
      if (!Array.isArray(entry) || !Array.isArray(entry[1])) continue;
      const items = entry[1].filter((item) => {
        const english = normalizePublishedSearchQuery(item?.replacement);
        const source = normalizePublishedSearchQuery(item?.source);
        return english.includes(query) || source.includes(query);
      });
      if (!items.length) continue;
      totalParagraphs++;
      totalOccurrences += items.length;
      if (matches.length < limit) {
        matches.push({
          chapterIndex: Number(chapter.chapterIndex),
          paragraphIndex: Number(entry[0]),
          items,
        });
      }
    }
  }
  return {
    query,
    matches,
    totalParagraphs,
    totalOccurrences,
    truncated: totalParagraphs > matches.length,
  };
}
