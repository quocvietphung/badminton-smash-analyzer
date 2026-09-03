const DATABASE_NAME = "smashlab-motion-lab";
const DATABASE_VERSION = 1;
const SESSION_STORE = "motion-sessions";

type StoredMotionSession = {
  id: string;
  createdAt: string;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB is not available"));
      return;
    }

    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SESSION_STORE)) {
        const store = database.createObjectStore(SESSION_STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Cannot open IndexedDB"));
  });
}

export async function readRecentMotionSessions<T extends StoredMotionSession>(limit = 12): Promise<T[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(SESSION_STORE, "readonly");
    const request = transaction.objectStore(SESSION_STORE).index("createdAt").openCursor(null, "prev");
    const results: T[] = [];

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || results.length >= limit) return;
      results.push(cursor.value as T);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error("Cannot read motion history"));
    transaction.oncomplete = () => {
      database.close();
      resolve(results);
    };
    transaction.onerror = () => reject(transaction.error ?? new Error("Cannot read motion history"));
  });
}

export async function saveMotionSession<T extends StoredMotionSession>(item: T, limit = 12): Promise<T[]> {
  const existing = await readRecentMotionSessions<T>(Math.max(0, limit - 1));
  const keepBeforeInsert = new Set(existing.map((entry) => entry.id));
  const pruneDatabase = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = pruneDatabase.transaction(SESSION_STORE, "readwrite");
    const store = transaction.objectStore(SESSION_STORE);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const value = cursor.value as StoredMotionSession;
      if (!keepBeforeInsert.has(value.id) && value.id !== item.id) cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Cannot prepare motion history"));
  });
  pruneDatabase.close();

  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(SESSION_STORE, "readwrite");
    transaction.objectStore(SESSION_STORE).put(item);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Cannot save motion session"));
  });
  database.close();

  const recent = await readRecentMotionSessions<T>(limit);
  const keep = new Set(recent.map((entry) => entry.id));
  const cleanupDatabase = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = cleanupDatabase.transaction(SESSION_STORE, "readwrite");
    const store = transaction.objectStore(SESSION_STORE);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const value = cursor.value as StoredMotionSession;
      if (!keep.has(value.id)) cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Cannot clean motion history"));
  });
  cleanupDatabase.close();
  return recent;
}
