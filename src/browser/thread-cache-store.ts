/** Disposable transcript data only. This database never owns backend or draft state. */
export const THREAD_CACHE_DATABASE = "codex-web-thread-cache";
export const THREAD_CACHE_SCHEMA = 1;
export const MiB = 1024 * 1024;
export type CacheConfig = { enabled: boolean; capacityMiB: 64 | 128 | 256 };
export type CacheTicket = {
  epoch: number;
  generation: number;
  revision: number;
};
export type CachePage = {
  id: string;
  order: number;
  bytes: number;
  json: string;
};
type Index = {
  key: string;
  used: number;
  bytes: number;
  pages: Omit<CachePage, "json">[];
};
type Control = CacheConfig & { epoch: number; serial?: number };
type Version = { generation: number; revision: number; used?: number };
type Lease = { key: string; thread: string; expires: number };
export type CacheNotice = {
  type: "update" | "invalidate" | "clear" | "config";
  key?: string;
};
const defaults: Control = { enabled: true, capacityMiB: 128, epoch: 0 };
const tables = ["control", "threads", "pages", "versions", "leases"];
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export function createThreadCacheStore(
  options: {
    factory?: () => IDBFactory;
    now?: () => number;
    timeoutMs?: number;
    maxThreads?: number;
    maxThreadBytes?: number;
    capacityBytes?: number;
    notify?: (notice: CacheNotice) => void;
    error?: (category: string) => void;
  } = {},
) {
  const now = options.now ?? Date.now;
  const timeout = options.timeoutMs ?? 1500;
  const maxThreads = options.maxThreads ?? 100;
  const maxThreadBytes = options.maxThreadBytes ?? 16 * MiB;
  let opening: Promise<IDBDatabase> | undefined;
  let failedUntil = 0;
  let closed = false;
  function open() {
    if (closed || now() < failedUntil)
      return Promise.reject(new Error("Unavailable"));
    return (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = (options.factory ?? (() => indexedDB))().open(
        THREAD_CACHE_DATABASE,
        THREAD_CACHE_SCHEMA,
      );
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        reject(new Error("Timeout"));
      }, timeout);
      r.onupgradeneeded = () => {
        for (const name of tables) r.result.createObjectStore(name);
      };
      r.onblocked = () => {
        expired = true;
        clearTimeout(timer);
        reject(new Error("Blocked"));
      };
      r.onerror = () => {
        clearTimeout(timer);
        reject(r.error);
      };
      r.onsuccess = () => {
        clearTimeout(timer);
        const db = r.result;
        if (expired || closed) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          opening = undefined;
        };
        resolve(db);
      };
    }).catch((error) => {
      opening = undefined;
      throw error;
    }));
  }
  async function transaction<T>(
    mode: IDBTransactionMode,
    operation: (tx: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    const db = await open();
    const tx = db.transaction(tables, mode);
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          tx.abort();
        } catch {}
      }, timeout);
      tx.oncomplete = () => {
        clearTimeout(timer);
        resolve();
      };
      tx.onabort = () => {
        clearTimeout(timer);
        reject(tx.error ?? new Error("Aborted"));
      };
      tx.onerror = () => {};
    });
    // Register rejection handling before an operation can fail/abort.
    void done.catch(() => {});
    try {
      const result = await operation(tx);
      await done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {}
      await done.catch(() => {});
      throw error;
    }
  }
  async function safe<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      failedUntil = now() + 5000;
      options.error?.(
        error instanceof Error
          ? error.name === "Error"
            ? error.message
            : error.name
          : "StorageError",
      );
      return fallback;
    }
  }
  const getControl = async (tx: IDBTransaction): Promise<Control> => {
    const c = await request(tx.objectStore("control").get("settings"));
    if (c === undefined) return { ...defaults };
    if (
      typeof c.enabled !== "boolean" ||
      ![64, 128, 256].includes(c.capacityMiB) ||
      !Number.isSafeInteger(c.epoch)
    )
      throw new Error("CorruptControl");
    return c;
  };
  const getVersion = async (
    tx: IDBTransaction,
    key: string,
  ): Promise<Version> =>
    (await request(tx.objectStore("versions").get(key))) ?? {
      generation: -1,
      revision: 0,
    };
  async function remove(tx: IDBTransaction, key: string, index?: Index) {
    const entry = index ?? (await request(tx.objectStore("threads").get(key)));
    for (const page of entry?.pages ?? [])
      tx.objectStore("pages").delete([key, page.id]);
    tx.objectStore("threads").delete(key);
    // New reads receive a globally unique generation. Deleting this record
    // fences old writers without retaining an unbounded tombstone per thread.
    tx.objectStore("versions").delete(key);
  }
  function announce(notice: CacheNotice) {
    options.notify?.(notice);
  }
  const api = {
    validTicket(key: string, ticket: CacheTicket) {
      return safe(false, () =>
        transaction("readonly", async (tx) => {
          const control = await getControl(tx),
            version = await getVersion(tx, key);
          return (
            control.enabled &&
            control.epoch === ticket.epoch &&
            version.generation === ticket.generation &&
            version.revision === ticket.revision
          );
        }),
      );
    },
    async readPages(
      key: string,
      tab?: string,
      recentTurns?: number,
    ): Promise<{ ticket: CacheTicket; pages: CachePage[] } | null> {
      return safe(null, () =>
        transaction("readwrite", async (tx) => {
          const control = await getControl(tx);
          if (!control.enabled) return null;
          let version = await getVersion(tx, key);
          if (version.generation < 0) {
            control.serial = Math.max(control.serial ?? 0, now() * 1000) + 1;
            version = { generation: control.serial, revision: 0 };
            tx.objectStore("control").put(control, "settings");
            tx.objectStore("versions").put(version, key);
          }
          const index: Index | undefined = await request(
            tx.objectStore("threads").get(key),
          );
          const pages: CachePage[] = [];
          let entries = index?.pages ?? [];
          if (recentTurns) {
            const ids = new Set<string>();
            entries = [...entries]
              .reverse()
              .filter((page) => {
                const id = page.id.split(":page:")[0]!;
                if (!ids.has(id) && ids.size >= recentTurns) return false;
                ids.add(id);
                return true;
              })
              .reverse();
          }
          for (const entry of entries) {
            const page = await request(
              tx.objectStore("pages").get([key, entry.id]),
            );
            if (
              !page ||
              typeof page.json !== "string" ||
              !Number.isFinite(page.bytes) ||
              page.bytes < 0 ||
              page.id !== entry.id
            ) {
              await remove(tx, key, index);
              return null;
            }
            pages.push(page);
          }
          if (tab) {
            version = { ...version, used: now() };
            tx.objectStore("versions").put(version, key);
            if (index)
              tx.objectStore("threads").put({ ...index, used: now() }, key);
            tx.objectStore("leases").put(
              {
                key: JSON.stringify([key, tab]),
                thread: key,
                expires: now() + 30000,
              },
              [key, tab],
            );
          }
          return { ticket: { epoch: control.epoch, ...version }, pages };
        }),
      );
    },
    async savePages(
      key: string,
      ticket: CacheTicket,
      incoming: CachePage[],
      keepIds: string[],
      preserveUnloaded = false,
    ): Promise<CacheTicket | null> {
      const evicted: string[] = [];
      const result = await safe(null, () =>
        transaction("readwrite", async (tx) => {
          const control = await getControl(tx),
            version = await getVersion(tx, key);
          if (
            !control.enabled ||
            ticket.epoch !== control.epoch ||
            ticket.generation !== version.generation ||
            ticket.revision !== version.revision
          )
            return null;
          const indexes: Index[] = await request(
            tx.objectStore("threads").getAll(),
          );
          const previous = indexes.find((x) => x.key === key);
          const keep = new Set(keepIds);
          if (preserveUnloaded && previous) {
            const loaded = new Set(keepIds.map((id) => id.split(":page:")[0]));
            for (const page of previous.pages)
              if (!loaded.has(page.id.split(":page:")[0])) keep.add(page.id);
            const anchor = incoming.find((page) =>
              previous.pages.some((p) => p.id === page.id),
            );
            const offset = anchor
              ? previous.pages.find((p) => p.id === anchor.id)!.order -
                anchor.order
              : Math.max(-1, ...previous.pages.map((p) => p.order)) + 1;
            incoming = incoming.map((page) => ({
              ...page,
              order: page.order + offset,
            }));
          }
          const merged = new Map(
            (previous?.pages ?? [])
              .filter((p) => keep.has(p.id))
              .map((p) => [p.id, p]),
          );
          const accepted = new Map<string, CachePage>();
          for (const page of incoming) {
            if (
              !keep.has(page.id) ||
              !Number.isFinite(page.bytes) ||
              page.bytes < 0 ||
              page.bytes > maxThreadBytes
            ) {
              merged.delete(page.id);
              continue;
            }
            accepted.set(page.id, page);
            merged.set(page.id, {
              id: page.id,
              order: page.order,
              bytes: page.bytes,
            });
          }
          let bytes = 0;
          const pages = [...merged.values()]
            .sort((a, b) => b.order - a.order)
            .filter((page) => {
              if (bytes + page.bytes > maxThreadBytes) return false;
              bytes += page.bytes;
              return true;
            })
            .sort((a, b) => a.order - b.order);
          const retained = new Set(pages.map((p) => p.id));
          const leases: Lease[] = await request(
            tx.objectStore("leases").getAll(),
          );
          const protectedKeys = new Set<string>();
          for (const lease of leases) {
            if (lease.expires > now()) protectedKeys.add(lease.thread);
            else tx.objectStore("leases").delete(JSON.parse(lease.key));
          }
          const others = indexes.filter((x) => x.key !== key);
          let total = others.reduce((sum, x) => sum + x.bytes, 0) + bytes;
          let count = others.length + (pages.length ? 1 : 0);
          const evictions: Index[] = [];
          for (const index of others.sort(
            (a, b) => a.used - b.used || a.key.localeCompare(b.key),
          )) {
            if (
              total <= (options.capacityBytes ?? control.capacityMiB * MiB) &&
              count <= maxThreads
            )
              break;
            if (protectedKeys.has(index.key)) continue;
            total -= index.bytes;
            count--;
            evictions.push(index);
          }
          if (
            total > (options.capacityBytes ?? control.capacityMiB * MiB) ||
            count > maxThreads
          )
            return null;
          for (const index of evictions) {
            await remove(tx, index.key, index);
            evicted.push(index.key);
          }
          for (const page of previous?.pages ?? [])
            if (!retained.has(page.id))
              tx.objectStore("pages").delete([key, page.id]);
          for (const page of accepted.values())
            if (retained.has(page.id))
              tx.objectStore("pages").put(page, [key, page.id]);
          if (pages.length)
            tx.objectStore("threads").put(
              {
                key,
                used: previous?.used ?? version.used ?? now(),
                bytes,
                pages,
              },
              key,
            );
          else tx.objectStore("threads").delete(key);
          const next = { ...version, revision: version.revision + 1 };
          tx.objectStore("versions").put(next, key);
          return { epoch: control.epoch, ...next };
        }),
      );
      if (result) {
        for (const key of evicted) announce({ type: "invalidate", key });
        announce({ type: "update", key });
      }
      return result;
    },
    async touch(key: string, tab: string, viewed = true) {
      return safe(false, () =>
        transaction("readwrite", async (tx) => {
          if (!(await getControl(tx)).enabled) return false;
          const index = await request(tx.objectStore("threads").get(key));
          if (viewed) {
            const version = await getVersion(tx, key);
            if (version.generation >= 0)
              tx.objectStore("versions").put({ ...version, used: now() }, key);
          }
          if (viewed && index)
            tx.objectStore("threads").put({ ...index, used: now() }, key);
          tx.objectStore("leases").put(
            {
              key: JSON.stringify([key, tab]),
              thread: key,
              expires: now() + 30000,
            },
            [key, tab],
          );
          return true;
        }),
      );
    },
    async release(key: string, tab: string) {
      await safe(null, () =>
        transaction("readwrite", async (tx) => {
          tx.objectStore("leases").delete([key, tab]);
          if (!(await request(tx.objectStore("threads").get(key)))) {
            const leases: Lease[] = await request(
              tx.objectStore("leases").getAll(),
            );
            if (!leases.some((l) => l.thread === key && l.expires > now()))
              tx.objectStore("versions").delete(key);
          }
          return null;
        }),
      );
    },
    async invalidate(key: string) {
      await safe(null, () =>
        transaction("readwrite", async (tx) => {
          await remove(tx, key);
          return null;
        }),
      );
      announce({ type: "invalidate", key });
    },
    async invalidateScope(scope: string) {
      const removed = await safe<string[]>([], () =>
        transaction("readwrite", async (tx) => {
          const versions = await request(
            tx.objectStore("versions").getAllKeys(),
          );
          const keys: string[] = [];
          for (const key of versions) {
            if (typeof key !== "string") continue;
            let matches = false;
            try {
              matches = JSON.parse(key)[0] === scope;
            } catch {}
            if (matches) {
              await remove(tx, key);
              keys.push(key);
            }
          }
          return keys;
        }),
      );
      for (const key of removed) announce({ type: "invalidate", key });
    },
    async configure(config: Partial<CacheConfig> = {}, clear = false) {
      const evicted: string[] = [];
      const result = await safe(null, () =>
        transaction("readwrite", async (tx) => {
          const previous = await getControl(tx);
          const capacityMiB = config.capacityMiB ?? previous.capacityMiB;
          if (![64, 128, 256].includes(capacityMiB))
            throw new Error("InvalidCapacity");
          const enabled = config.enabled ?? previous.enabled;
          const reset = clear || !enabled;
          const next = {
            ...previous,
            enabled,
            capacityMiB,
            epoch: previous.epoch + (reset ? 1 : 0),
          };
          tx.objectStore("control").put(next, "settings");
          if (reset)
            for (const name of tables.slice(1)) tx.objectStore(name).clear();
          else if (capacityMiB < previous.capacityMiB) {
            const indexes: Index[] = await request(
              tx.objectStore("threads").getAll(),
            );
            const leases: Lease[] = await request(
              tx.objectStore("leases").getAll(),
            );
            const protectedKeys = new Set(
              leases.filter((l) => l.expires > now()).map((l) => l.thread),
            );
            let bytes = indexes.reduce((n, i) => n + i.bytes, 0);
            for (const index of indexes.sort((a, b) => a.used - b.used)) {
              if (bytes <= capacityMiB * MiB) break;
              if (protectedKeys.has(index.key)) continue;
              await remove(tx, index.key, index);
              evicted.push(index.key);
              bytes -= index.bytes;
            }
          }
          return next;
        }),
      );
      if (result)
        for (const key of evicted) announce({ type: "invalidate", key });
      announce({
        type: clear || config.enabled === false ? "clear" : "config",
      });
      return result;
    },
    clear() {
      return api.configure({}, true);
    },
    stats() {
      return safe(null, () =>
        transaction("readonly", async (tx) => {
          const config = await getControl(tx);
          const indexes: Index[] = await request(
            tx.objectStore("threads").getAll(),
          );
          return {
            ...config,
            threads: indexes.length,
            pages: indexes.reduce((n, i) => n + i.pages.length, 0),
            bytes: indexes.reduce((n, i) => n + i.bytes, 0),
          };
        }),
      );
    },
    close() {
      closed = true;
      void opening?.then((db) => db.close()).catch(() => {});
      opening = undefined;
    },
  };
  return api;
}
export type ThreadCacheStore = ReturnType<typeof createThreadCacheStore>;
