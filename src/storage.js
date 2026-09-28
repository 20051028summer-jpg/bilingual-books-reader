import { chapterCacheKeys, legacyChapterIndex } from "./cache-keys.js";
import { publishedRecordsForBook } from "./published-sync.js";
import { isChapterRecord, mergeSharedChapter } from "./shared-chapter.js";

const DB_NAME = "wordnov-ai-reader";
const STORE_NAME = "chapter-results";
const STATE_STORE = "app-state";
const DB_VERSION = 2;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readCachedChapter(key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function listBookChapterCaches(bookId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const result = [];
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const value = cursor.value;
      if (value?.shared === true && value.bookId === bookId && Number.isInteger(value.chapterIndex)) {
        result.push(value);
      }
      cursor.continue();
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result.sort((a, b) => a.chapterIndex - b.chapterIndex));
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(tx.error || new Error("读取章节缓存失败"));
    };
  });
}

export async function writeCachedChapter(key, value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => {
      if (value.bookId && Number.isInteger(value.chapterIndex)) {
        store.put(mergeSharedChapter([{ key, value: request.result }, { key, value }], value), key);
      } else store.put(value, key);
    };
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error("本地缓存事务中断")); };
  });
}

export async function syncPublishedManifest(bookId, manifest) {
  const published = publishedRecordsForBook(bookId, manifest);
  if (!published.compatible) return { compatible: false, changedCount: 0, chapterCount: 0 };
  if (published.records.length === 0) return { compatible: true, changedCount: 0, chapterCount: 0 };

  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    let changedCount = 0;
    for (const value of published.records) {
      const key = chapterCacheKeys(value).current;
      const request = store.get(key);
      request.onsuccess = () => {
        const existing = request.result;
        const merged = mergeSharedChapter([{ key, value: existing }, { key, value }], value);
        if (JSON.stringify(existing) === JSON.stringify(merged)) return;
        store.put(merged, key);
        changedCount += 1;
      };
    }
    tx.oncomplete = () => {
      db.close();
      resolve({ compatible: true, changedCount, chapterCount: published.records.length });
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(tx.error || new Error("发布内容同步事务未完成；原记录已回滚"));
    };
  });
}

export async function migrateBookCache(bookId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const groups = new Map();
    let retiredCount = 0;
    const cursorRequest = store.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        const value = cursor.value;
        const legacyIndex = legacyChapterIndex(cursor.key, bookId);
        const index = legacyIndex ?? (value?.shared && value.bookId === bookId ? value.chapterIndex : null);
        if (Number.isInteger(index) && isChapterRecord(value)) {
          if (!groups.has(index)) groups.set(index, []);
          groups.get(index).push({ key: cursor.key, value });
        }
        cursor.continue();
        return;
      }
      try {
        for (const [chapterIndex, records] of groups) {
          const key = chapterCacheKeys({ bookId, chapterIndex }).current;
          if (records.length === 1 && records[0].key === key) continue;
          const merged = mergeSharedChapter(records, { bookId, chapterIndex });
          store.put(merged, key);
          for (const record of records) {
            if (record.key !== key) { store.delete(record.key); retiredCount++; }
          }
        }
      } catch (error) { tx.abort(); reject(error); }
    };
    tx.oncomplete = () => { db.close(); resolve({ retiredCount, chapterCount: groups.size }); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error("缓存合并事务未完成；原记录已回滚")); };
  });
}

export async function writeLastBook(file, bookId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STATE_STORE, "readwrite");
    tx.objectStore(STATE_STORE).put({
      bookId,
      name: file.name,
      type: file.type,
      size: file.size,
      lastModified: file.lastModified,
      savedAt: Date.now(),
    }, "last-book");
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error("本地书籍保存事务中断")); };
  });
}

export async function listSavedBooks() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STATE_STORE, "readonly");
    const request = tx.objectStore(STATE_STORE).get("book-library");
    request.onsuccess = () => resolve(Array.isArray(request.result?.books) ? request.result.books : []);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function readSavedBook(bookId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STATE_STORE, "readonly");
    const request = tx.objectStore(STATE_STORE).get(`book:${bookId}`);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function saveBookToLibrary(file, book) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STATE_STORE, "readwrite");
    const store = tx.objectStore(STATE_STORE);
    const request = store.get("book-library");
    request.onsuccess = () => {
      const savedAt = Date.now();
      const existing = Array.isArray(request.result?.books) ? request.result.books : [];
      const books = existing.filter((entry) => entry.id !== book.id);
      books.unshift({
        id: book.id,
        title: book.title,
        format: book.format,
        chapterCount: book.chapters.length,
        size: file.size,
        lastModified: file.lastModified,
        savedAt,
      });
      store.put({ name: file.name, type: file.type, size: file.size, lastModified: file.lastModified, blob: file, savedAt }, `book:${book.id}`);
      store.put({ books, updatedAt: savedAt }, "book-library");
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error("保存书架数据失败")); };
  });
}

export async function deleteSavedBook(bookId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, STATE_STORE], "readwrite");
    const chapterStore = tx.objectStore(STORE_NAME);
    const stateStore = tx.objectStore(STATE_STORE);
    stateStore.delete(`book:${bookId}`);
    const libraryRequest = stateStore.get("book-library");
    libraryRequest.onsuccess = () => {
      const books = Array.isArray(libraryRequest.result?.books) ? libraryRequest.result.books : [];
      stateStore.put({ books: books.filter((entry) => entry.id !== bookId), updatedAt: Date.now() }, "book-library");
    };
    const lastBookRequest = stateStore.get("last-book");
    lastBookRequest.onsuccess = () => {
      if (lastBookRequest.result?.bookId === bookId) stateStore.delete("last-book");
    };
    const cursorRequest = chapterStore.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const value = cursor.value;
      if (value?.bookId === bookId || legacyChapterIndex(String(cursor.key), bookId) !== null) cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error("删除书籍和章节缓存失败")); };
  });
}

export async function readLastBook() {
  const db = await openDatabase();
  const stored = await new Promise((resolve, reject) => {
    const tx = db.transaction(STATE_STORE, "readonly");
    const request = tx.objectStore(STATE_STORE).get("last-book");
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
  if (stored?.blob || !stored?.bookId) return stored;
  return (await readSavedBook(stored.bookId)) || stored;
}

export async function clearAllStoredData() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, STATE_STORE], "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.objectStore(STATE_STORE).clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

export async function getStorageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const estimate = await navigator.storage.estimate();
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
}
