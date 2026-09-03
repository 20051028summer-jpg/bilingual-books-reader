export function chapterCacheKeys({ bookId, chapterIndex }) {
  return { current: `shared:${encodeURIComponent(bookId)}:${chapterIndex}` };
}

export function legacyChapterIndex(key, bookId) {
  if (typeof key !== "string" || !key.startsWith(`${bookId}:`)) return null;
  const match = key.slice(bookId.length + 1).match(/^(\d+):cet[46]:(?:light|medium|dense):/);
  return match ? Number(match[1]) : null;
}

export async function readModelChapterCache(read, keys) {
  return read(keys.current);
}
