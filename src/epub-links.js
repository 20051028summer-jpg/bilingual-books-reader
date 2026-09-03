function normalizeBookPath(value = "") {
  return decodeURIComponent(value).replace(/^\/+/, "").replace(/^\.\//, "");
}

export function resolveEpubHref(chapters, currentIndex, href) {
  const rawHref = String(href ?? "").trim();
  if (!rawHref) return null;
  if (/^(?:https?:|mailto:|tel:)/i.test(rawHref)) return { external: true, url: rawHref };
  const currentHref = chapters[currentIndex]?.href ?? "";
  const base = new URL(normalizeBookPath(currentHref), "https://epub.local/");
  const resolved = new URL(rawHref, base);
  const targetPath = normalizeBookPath(resolved.pathname);
  const fragment = resolved.hash ? decodeURIComponent(resolved.hash.slice(1)) : "";
  let index = currentIndex;
  if (rawHref.split("#")[0]) {
    index = chapters.findIndex((chapter) => {
      const chapterPath = normalizeBookPath(chapter.href);
      return chapterPath === targetPath || chapterPath.endsWith(`/${targetPath}`) || targetPath.endsWith(`/${chapterPath}`);
    });
  }
  if (index < 0) return null;
  return { external: false, index, fragment };
}
