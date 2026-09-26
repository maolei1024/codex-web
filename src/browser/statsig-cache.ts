/** Local, identity-scoped configuration snapshots. Never a source of authorization. */
export const STATSIG_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const STATSIG_CACHE_MAX_BYTES = 32 * 1024 * 1024;
export const STATSIG_CACHE_ENTRY_MAX_BYTES = 8 * 1024 * 1024;
const CACHE_SCHEMA = 1;
const CACHE_DB = "codex-web-feature-config-v1";
const CACHE_STORE = "snapshots";

type User = Record<string, unknown>;
type UpdateResult = { success?: boolean; [key: string]: unknown };
export type StatsigClientLike = {
  loadingStatus: string;
  initializeAsync(options?: unknown): Promise<UpdateResult>;
  initializeSync(options?: unknown): UpdateResult;
  refreshValuesAsync(options?: unknown): Promise<UpdateResult>;
  getContext(): { user: User; values?: unknown };
  dataAdapter: {
    setData(data: string, user?: User): void;
    getDataSync(user: User): {
      data: string;
      source: string;
      receivedAt: number;
    } | null;
  };
  on(event: string, listener: () => void): void;
};
export type CacheRecord = {
  schema: number;
  key: string;
  savedAt: number;
  payload: string;
  bytes: number;
};
export type SnapshotStore = {
  get(key: string): Promise<CacheRecord | undefined>;
  put(record: CacheRecord): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function targetingIdentity(user: User): string {
  const normalized = { ...user };
  if (isObject(user.custom)) {
    normalized.custom = { ...user.custom };
    // This is analytics-only session metadata, not a targeting identity.
    delete (normalized.custom as User).codex_app_session_id;
  }
  return canonical(normalized);
}

export async function snapshotKey(
  sdkKey: string,
  buildId: string,
  user: User,
): Promise<string> {
  const data = new TextEncoder().encode(
    canonical([CACHE_SCHEMA, buildId, sdkKey, targetingIdentity(user)]),
  );
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function parseSnapshot(
  record: CacheRecord | undefined,
  key: string,
  now: number,
): User | null {
  if (
    !record ||
    record.schema !== CACHE_SCHEMA ||
    record.key !== key ||
    !Number.isFinite(record.savedAt) ||
    record.savedAt > now ||
    now - record.savedAt >= STATSIG_CACHE_TTL_MS ||
    typeof record.payload !== "string" ||
    record.payload.length > STATSIG_CACHE_ENTRY_MAX_BYTES ||
    !Number.isFinite(record.bytes) ||
    record.bytes <= 0 ||
    record.bytes > STATSIG_CACHE_ENTRY_MAX_BYTES ||
    new TextEncoder().encode(record.payload).byteLength !== record.bytes
  )
    return null;
  try {
    const value: unknown = JSON.parse(record.payload);
    return isObject(value) &&
      value.has_updates === true &&
      isObject(value.feature_gates) &&
      isObject(value.dynamic_configs) &&
      isObject(value.layer_configs)
      ? value
      : null;
  } catch {
    return null;
  }
}

/** IndexedDB work is asynchronous, bounded, and independent of SDK telemetry storage. */
export class IndexedDbSnapshotStore implements SnapshotStore {
  private async database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_DB, CACHE_SCHEMA);
      let finished = false;
      const timer = setTimeout(() => {
        finished = true;
        reject(new Error("cache open timeout"));
      }, 200);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(CACHE_STORE)) {
          request.result.createObjectStore(CACHE_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        if (finished) {
          request.result.close();
          return;
        }
        finished = true;
        resolve(request.result);
      };
      request.onerror = () => {
        clearTimeout(timer);
        finished = true;
        reject(request.error);
      };
    });
  }

  private async transaction<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore, result: (value: T) => void) => void,
  ): Promise<T> {
    const db = await this.database();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE, mode);
        let value: T;
        const timer = setTimeout(() => {
          transaction.abort();
        }, 500);
        transaction.oncomplete = () => {
          clearTimeout(timer);
          resolve(value!);
        };
        transaction.onabort = transaction.onerror = () => {
          clearTimeout(timer);
          reject(transaction.error ?? new Error("cache transaction aborted"));
        };
        try {
          action(transaction.objectStore(CACHE_STORE), (result) => {
            value = result;
          });
        } catch (error) {
          transaction.abort();
          reject(error);
        }
      });
    } finally {
      db.close();
    }
  }

  get(key: string): Promise<CacheRecord | undefined> {
    return this.transaction("readonly", (store, result) => {
      const request = store.get(key);
      request.onsuccess = () => result(request.result);
    });
  }

  put(record: CacheRecord): Promise<void> {
    return this.transaction("readwrite", (store) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const now = Date.now();
        const entries = (request.result as CacheRecord[])
          .filter((entry) => {
            if (entry.key === record.key) return false;
            if (!parseSnapshot(entry, entry.key, now)) {
              store.delete(entry.key);
              return false;
            }
            return true;
          })
          .sort((a, b) => b.savedAt - a.savedAt);
        let total = record.bytes;
        for (const [index, entry] of entries.entries()) {
          total += entry.bytes;
          if (total > STATSIG_CACHE_MAX_BYTES || index >= 7)
            store.delete(entry.key);
        }
        store.put(record);
      };
    });
  }

  delete(key: string): Promise<void> {
    return this.transaction("readwrite", (store) => {
      store.delete(key);
    });
  }

  clear(): Promise<void> {
    return this.transaction("readwrite", (store) => {
      store.clear();
    });
  }
}

const browserStore = new IndexedDbSnapshotStore();
const configured = new WeakSet<StatsigClientLike>();
let cacheGeneration = 0;

export function clearStatsigSnapshots(): void {
  cacheGeneration += 1;
  void browserStore.clear().catch(() => {});
}

function afterStartup(callback: () => void): void {
  setTimeout(() => {
    if (typeof requestIdleCallback === "function")
      requestIdleCallback(callback, { timeout: 2_000 });
    else callback();
  }, 2_000);
}

type CacheDependencies = {
  store?: SnapshotStore;
  now?: () => number;
  schedule?: (callback: () => void) => void;
  mark?: (event: string) => void;
};

/** Keep the upstream client and its refresh/events; change only the initial wait. */
export function configureStatsigClient<T extends StatsigClientLike>(
  client: T,
  sdkKey: string,
  buildId: string,
  dependencies: CacheDependencies = {},
): T {
  if (configured.has(client)) return client;
  configured.add(client);
  const store = dependencies.store ?? browserStore;
  const now = dependencies.now ?? Date.now;
  const schedule = dependencies.schedule ?? afterStartup;
  const mark =
    dependencies.mark ??
    ((event) => performance.mark(`codex-web:statsig-${event}`));
  const originalInitialize = client.initializeAsync.bind(client);
  let initialization: Promise<UpdateResult> | undefined;
  let lastSaved = "";
  let refreshing = false;
  let active = true;
  const generation = cacheGeneration;

  const saveNetworkSnapshot = async (): Promise<void> => {
    if (
      !active ||
      generation !== cacheGeneration ||
      client.loadingStatus !== "Ready"
    )
      return;
    const user = client.getContext().user;
    const data = client.dataAdapter.getDataSync(user);
    // Cached/Bootstrap fallback must never renew a snapshot's 24-hour lifetime.
    if (
      !data ||
      !["Network", "NetworkNotModified", "Prefetch"].includes(data.source)
    )
      return;
    const key = await snapshotKey(sdkKey, buildId, user);
    const receivedAt = data.receivedAt;
    if (
      lastSaved === `${key}:${receivedAt}` ||
      !Number.isFinite(receivedAt) ||
      receivedAt > now()
    )
      return;
    const bytes = new TextEncoder().encode(data.data).byteLength;
    const record: CacheRecord = {
      schema: CACHE_SCHEMA,
      key,
      savedAt: receivedAt,
      payload: data.data,
      bytes,
    };
    if (
      !active ||
      !parseSnapshot(record, key, now()) ||
      generation !== cacheGeneration
    )
      return;
    lastSaved = `${key}:${receivedAt}`;
    try {
      await store.put(record);
    } catch (error) {
      lastSaved = "";
      throw error;
    }
  };
  client.on("values_updated", () => {
    void saveNetworkSnapshot().catch(() => {});
  });
  client.on("client_shutdown", () => {
    active = false;
  });

  client.initializeAsync = (options?: unknown) => {
    initialization ??= (async () => {
      let identity = "";
      try {
        const user = client.getContext().user;
        identity = targetingIdentity(user);
        const key = await snapshotKey(sdkKey, buildId, user);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cached = await Promise.race([
          store.get(key),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(resolve, 250);
          }),
        ]).finally(() => {
          clearTimeout(timer);
        });
        const payload = parseSnapshot(cached, key, now());
        if (!payload && cached) void store.delete(key).catch(() => {});
        if (
          payload &&
          active &&
          generation === cacheGeneration &&
          identity === targetingIdentity(client.getContext().user)
        ) {
          // Re-associate analytics-only session metadata after the full targeting match.
          payload.user = client.getContext().user;
          client.dataAdapter.setData(
            JSON.stringify(payload),
            client.getContext().user,
          );
          const result = client.initializeSync({
            disableBackgroundCacheRefresh: true,
          });
          if (result.success !== false && client.loadingStatus === "Ready") {
            mark("cache-hit");
            mark("ready");
            schedule(() => {
              if (
                !active ||
                generation !== cacheGeneration ||
                refreshing ||
                identity !== targetingIdentity(client.getContext().user)
              )
                return;
              refreshing = true;
              void client
                .refreshValuesAsync({ timeoutMs: 15_000 })
                .then(() => saveNetworkSnapshot())
                .catch(() => {})
                .finally(() => {
                  refreshing = false;
                });
            });
            return result;
          }
        }
      } catch {
        // Private browsing, blocked/evicted storage and invalid snapshots use upstream.
      }
      mark("cache-miss");
      const result = await originalInitialize(options);
      // Persist after returning control to the UI; slow storage is never a
      // second startup barrier after the upstream network request completes.
      void saveNetworkSnapshot().catch(() => {});
      mark("ready");
      return result;
    })();
    return initialization;
  };
  return client;
}
