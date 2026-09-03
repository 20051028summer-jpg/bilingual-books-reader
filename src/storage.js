import { chapterCacheKeys, legacyChapterIndex } from "./cache-keys.js";
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

export async function writeLastBook(file) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STATE_STORE, "readwrite");
    tx.objectStore(STATE_STORE).put({
      name: file.name,
      type: file.type,
      size: file.size,
      lastModified: file.lastModified,
      blob: file,
      savedAt: Date.now(),
    }, "last-book");
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error("本地书籍保存事务中断")); };
  });
}

export async function readLastBook() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STATE_STORE, "readonly");
    const request = tx.objectStore(STATE_STORE).get("last-book");
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
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
