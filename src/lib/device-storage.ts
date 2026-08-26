const DATABASE_NAME = "smashlab-pose-lite";
const DATABASE_VERSION = 1;
const RALLY_STORE = "rallies";

type StoredRally = {
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
      if (!database.objectStoreNames.contains(RALLY_STORE)) {
        const store = database.createObjectStore(RALLY_STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Cannot open IndexedDB"));
  });
}

export async function readRecentRallies<T extends StoredRally>(limit = 12): Promise<T[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(RALLY_STORE, "readonly");
    const request = transaction.objectStore(RALLY_STORE).index("createdAt").openCursor(null, "prev");
    const results: T[] = [];

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || results.length >= limit) return;
      results.push(cursor.value as T);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error("Cannot read rally history"));
    transaction.oncomplete = () => {
      database.close();
      resolve(results);
    };
    transaction.onerror = () => reject(transaction.error ?? new Error("Cannot read rally history"));
  });
}

export async function saveRally<T extends StoredRally>(item: T, limit = 12): Promise<T[]> {
  const database = await openDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(RALLY_STORE, "readwrite");
    transaction.objectStore(RALLY_STORE).put(item);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Cannot save rally"));
  });
  database.close();

  const recent = await readRecentRallies<T>(limit);
  const keep = new Set(recent.map((entry) => entry.id));
  const cleanupDatabase = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = cleanupDatabase.transaction(RALLY_STORE, "readwrite");
    const store = transaction.objectStore(RALLY_STORE);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const value = cursor.value as StoredRally;
      if (!keep.has(value.id)) cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Cannot clean rally history"));
  });
  cleanupDatabase.close();
  return recent;
}

export async function migrateLegacyRallies<T extends StoredRally>(items: T[]): Promise<T[]> {
  if (!items.length) return readRecentRallies<T>();
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(RALLY_STORE, "readwrite");
    const store = transaction.objectStore(RALLY_STORE);
    items.forEach((item) => store.put(item));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Cannot migrate rally history"));
  });
  database.close();
  return readRecentRallies<T>();
}
