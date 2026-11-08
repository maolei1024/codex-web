import {
  createThreadCacheStore,
  type CacheNotice,
  type CachePage,
  type CacheTicket,
  type ThreadCacheStore,
} from "./thread-cache-store";
import { restoreTurns, turnDetails, type TurnPage } from "./thread-cache-codec";

// Deliberately a narrow adapter to Desktop 26.1007.71326, not an RPC interceptor.
type Native = {
  readState: any;
  transcript(state: any): any;
  turns(state: any): any[];
  complete(state: any): boolean;
  placeholder?(id: string, metadata: any): any;
};
type View = {
  id: string;
  key: string;
  lease: string;
  refs: number;
  generation: number;
  ticket?: CacheTicket;
  cached?: any[];
  metadata?: any;
  usedProjection: boolean;
  reading: boolean;
  readAgain?: boolean;
  writing: boolean;
  pending: boolean;
  finalPending?: boolean;
  olderRequest?: number;
  timer?: ReturnType<typeof setTimeout>;
  lastWrite: number;
  saved: Map<string, { items: any[]; details: any; order: number }>;
};
type Codec = (operation: "encode" | "decode", page: any) => Promise<any>;

function workerCodec(copyMeasured: (duration: number) => void): Codec {
  let worker: Worker | undefined;
  let sequence = 0;
  const pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  function fail() {
    worker?.terminate();
    worker = undefined;
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("CodecUnavailable"));
    }
    pending.clear();
  }
  return (operation, page) =>
    new Promise((resolve, reject) => {
      try {
        if (!worker) {
          worker = new Worker(
            new URL("./thread-cache-worker.ts", import.meta.url),
            { type: "module" },
          );
          worker.onmessage = ({ data }) => {
            const call = pending.get(data.id);
            if (!call) return;
            pending.delete(data.id);
            clearTimeout(call.timer);
            data.error
              ? call.reject(new Error(data.error))
              : call.resolve(data.result);
          };
          worker.onerror = fail;
        }
        const id = ++sequence;
        pending.set(id, { resolve, reject, timer: setTimeout(fail, 1500) });
        const started = performance.now();
        worker.postMessage({ id, operation, page });
        copyMeasured(performance.now() - started);
      } catch {
        fail();
        reject(new Error("CodecUnavailable"));
      }
    });
}

export function createThreadCache(
  options: {
    store?: ThreadCacheStore;
    codec?: Codec;
    origin?: string;
    tab?: string;
    channel?: Pick<BroadcastChannel, "postMessage" | "addEventListener"> | null;
    onSync?: (count: number) => void;
    now?: () => number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const tab = options.tab ?? crypto.randomUUID();
  let maxCodecCopyMs = 0;
  const codec =
    options.codec ??
    workerCodec((ms) => {
      maxCodecCopyMs = Math.max(ms, maxCodecCopyMs);
    });
  const listeners = new Set<() => void>();
  const controllers = new Set<{
    reset: (key?: string) => void;
    connection: () => void;
    enabled: () => void;
  }>();
  const errors: Record<string, number> = {};
  const counts = { hits: 0, misses: 0, writes: 0, skipped: 0 };
  let authenticationFailed = false;
  let connection = 0;
  let syncing = 0;
  let channel = options.channel;
  if (channel === undefined) {
    try {
      channel = new BroadcastChannel("codex-web-thread-cache");
    } catch {
      channel = null;
    }
  }
  function emit() {
    for (const fn of listeners) fn();
  }
  function changed(notice: CacheNotice, remote = false) {
    if (notice.type === "clear" || notice.type === "invalidate")
      for (const c of controllers) c.reset(notice.key);
    if (notice.type === "config") for (const c of controllers) c.enabled();
    if (!remote) channel?.postMessage(notice);
    emit();
  }
  channel?.addEventListener("message", (event: any) => {
    const n = event.data;
    if (
      n &&
      ["update", "invalidate", "clear", "config"].includes(n.type) &&
      (n.key === undefined || typeof n.key === "string")
    )
      changed(n, true);
  });
  const store =
    options.store ??
    createThreadCacheStore({
      notify: changed,
      error: (category) => {
        errors[category] = (errors[category] ?? 0) + 1;
        emit();
      },
    });
  const api = {
    store,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    diagnostics() {
      return { ...counts, syncing, maxCodecCopyMs, errors: { ...errors } };
    },
    connectionChanged() {
      connection++;
      for (const c of controllers) c.connection();
    },
    authenticationFailed() {
      authenticationFailed = true;
      for (const c of controllers) c.reset();
    },
    async clear() {
      for (const c of controllers) c.reset();
      return store.clear();
    },
    async configure(config: Parameters<ThreadCacheStore["configure"]>[0]) {
      if (config?.enabled === false) for (const c of controllers) c.reset();
      const result = await store.configure(config);
      if (result?.enabled) for (const c of controllers) c.enabled();
      return result;
    },
    attach(manager: any, native: Native): () => void {
      const readState = native.readState;
      // A desktop adapter mismatch must disable this optional cache, never boot.
      if (
        typeof readState?.subscribeStatus !== "function" ||
        typeof readState?.historyCacheIdentity !== "function"
      )
        return () => {};
      const subscriptions = manager.threadStore.subscriptions;
      const originalSubscribe = subscriptions.subscribe;
      const originalConversation = subscriptions.owner.getConversation;
      const originalTranscript = subscriptions.owner.getTranscript;
      const originalNotify = subscriptions.notifyTranscript;
      const views = new Map<string, View>();
      let scope = "";
      let verifiedScope = "";
      let hostAuthenticated = true;
      let disposed = false;
      function identity() {
        const read = readState;
        const account = read?.historyCacheIdentity?.(),
          host = read?.executionHostKey(manager.getHostId());
        return !authenticationFailed &&
          hostAuthenticated &&
          read?.isReady() &&
          typeof account === "string" &&
          account &&
          typeof host === "string" &&
          host
          ? JSON.stringify([
              options.origin ?? location.origin,
              account,
              manager.getHostId(),
              host,
            ])
          : "";
      }
      function setCached(view: View, turns?: any[]) {
        if (!!view.cached !== !!turns) {
          syncing += turns ? 1 : -1;
          options.onSync?.(syncing);
        }
        view.cached = turns;
      }
      function notify(id: string) {
        const groups = subscriptions.get(id);
        if (!groups) return;
        // Native listeners re-read their selectors, preserving React's identity checks.
        for (const fields of groups.values())
          for (const record of fields.values())
            for (const fn of [...record.listeners] as Array<() => void>) fn();
      }
      function forget(view: View) {
        view.generation++;
        view.olderRequest = undefined;
        view.ticket = undefined;
        view.readAgain = false;
        view.saved.clear();
        clearTimeout(view.timer);
        view.timer = undefined;
        view.pending = false;
        setCached(view);
        notify(view.id);
      }
      function reset(key?: string) {
        for (const view of views.values())
          if (!key || key === view.key) forget(view);
      }
      function finishInactive(view: View) {
        if (view.refs || view.reading || view.writing || view.timer) return;
        void store.release(view.key, view.lease);
        const state = manager.getConversation(view.id);
        // Keep observing a viewed running turn so completion is persisted even
        // after navigation. Background snapshots never refresh LRU recency.
        if (
          !state ||
          !native.turns(state).some((t) => t.status === "inProgress")
        )
          if (views.get(view.id) === view) views.delete(view.id);
      }
      function projected(id: string) {
        const live = originalConversation(id),
          view = views.get(id);
        if (!view?.cached || identity() !== scope) return live;
        const display = live ?? native.placeholder?.(id, view.metadata);
        if (!display) return live;
        const turns = live ? native.turns(live) : [];
        // During native pagination only prepend a cached prefix with a matching
        // boundary. Every overlapping turn/message comes from current memory.
        let shown = view.cached;
        if (turns.length) {
          if (
            view.olderRequest == null ||
            display.turnsPagination?.hasLoadedOldest
          )
            return live;
          const boundary = shown.findIndex(
            (t) => t.turnId === turns[0]?.turnId,
          );
          if (boundary <= 0) return live;
          const overlap = shown.slice(boundary).map((t) => t.turnId);
          if (!overlap.every((id, index) => turns[index]?.turnId === id))
            return live;
          shown = [...shown.slice(0, boundary), ...turns];
        }
        view.usedProjection = true;
        return {
          ...display,
          turns: shown,
          turnHistory: undefined,
          itemTimeline: undefined,
          turnsPagination: { hasLoadedOldest: false, olderCursor: null },
        };
      }
      subscriptions.owner.getConversation = (id: string) => projected(id);
      subscriptions.owner.getTranscript = (id: string) => {
        const state = projected(id);
        return state && views.get(id)?.cached
          ? native.transcript(state)
          : originalTranscript(id);
      };
      subscriptions.notifyTranscript = function (id: string, update: any) {
        const view = views.get(id);
        if (view?.cached || view?.usedProjection) {
          const state = projected(id);
          update = state ? native.transcript(state) : originalTranscript(id);
          const live = originalConversation(id);
          if (live && native.turns(live).length && view.olderRequest == null) {
            setCached(view);
            view.usedProjection = false;
          }
        }
        return originalNotify.call(this, id, update);
      };
      async function read(view: View) {
        if (view.reading || !scope || disposed) return;
        view.reading = true;
        const generation = view.generation,
          connectionAtStart = connection;
        const before = manager.getConversation(view.id);
        const beforeTurns = before && native.turns(before);
        try {
          const result = await store.readPages(view.key, view.lease, 5);
          if (
            !result ||
            generation !== view.generation ||
            connectionAtStart !== connection ||
            identity() !== scope
          )
            return;
          view.ticket = result.ticket;
          if (!view.refs) return;
          if (!result.pages.length) {
            counts.misses++;
            return;
          }
          // Decode the most recent five turns first, matching the pinned native initial page.
          const tailIds = new Set<string>();
          const tail: CachePage[] = [];
          for (const page of [...result.pages].reverse()) {
            const id = page.id.split(":page:")[0];
            if (!tailIds.has(id) && tailIds.size === 5) break;
            tailIds.add(id);
            tail.unshift(page);
          }
          const pages: TurnPage[] = [];
          for (const page of tail) pages.push(await codec("decode", page));
          const valid = await store.validTicket(view.key, result.ticket);
          const live = manager.getConversation(view.id);
          if (
            !valid ||
            generation !== view.generation ||
            connectionAtStart !== connection ||
            identity() !== scope ||
            !view.refs ||
            (live &&
              (native.turns(live).length || live.resumeState === "resumed")) ||
            beforeTurns?.length
          )
            return;
          const turns = restoreTurns(pages);
          if (turns.length) {
            view.metadata = pages.at(-1)?.metadata;
            setCached(view, turns);
            counts.hits++;
            notify(view.id);
          }
        } catch {
          await store.invalidate(view.key);
        } finally {
          view.reading = false;
          const again = view.readAgain;
          view.readAgain = false;
          if (again && view.refs && scope && !disposed) void read(view);
          else if (view.pending) schedule(view);
          finishInactive(view);
        }
      }
      function requestRead(view: View) {
        if (view.reading) view.readAgain = true;
        else void read(view);
      }
      function begin(id: string) {
        let view = views.get(id);
        if (!view) {
          view = {
            id,
            key: JSON.stringify([scope, id]),
            lease: "",
            refs: 0,
            generation: 0,
            usedProjection: false,
            reading: false,
            writing: false,
            pending: false,
            lastWrite: 0,
            saved: new Map(),
          };
          views.set(id, view);
        }
        view.refs++;
        if (view.refs === 1) {
          view.lease = `${tab}:${crypto.randomUUID()}`;
          view.pending = true;
          requestRead(view);
          if (scope) void store.touch(view.key, view.lease);
        }
        return () => {
          if (!view || --view.refs > 0) return;
          setCached(view);
          schedule(view, true);
          finishInactive(view);
        };
      }
      subscriptions.subscribe = function (request: any) {
        const release =
          request.type === "conversation"
            ? begin(request.key.threadId)
            : undefined;
        try {
          const off = originalSubscribe.call(this, request);
          return () => {
            off();
            release?.();
          };
        } catch (error) {
          release?.();
          throw error;
        }
      };
      // Warm already-viewed historical pages alongside the pinned native loader.
      // The original request starts immediately and remains authoritative. Its
      // completion removes the projection even when continuity was not confirmed.
      const originalOlder = manager.loadOlderConversationTurnsPage;
      let olderSequence = 0;
      if (typeof originalOlder === "function") {
        manager.loadOlderConversationTurnsPage = function (
          id: string,
          ...args: any[]
        ) {
          const view = views.get(id),
            request = ++olderSequence;
          const generation = view?.generation,
            connectionAtStart = connection;
          if (view?.refs && scope) {
            view.olderRequest = request;
            const current = manager.getConversation(id);
            const limit = (current ? native.turns(current).length : 0) + 5;
            void (async () => {
              const result = await store.readPages(view.key, view.lease, limit);
              if (!result?.pages.length) return;
              const pages: TurnPage[] = [];
              for (const page of result.pages)
                pages.push(await codec("decode", page));
              if (
                view.olderRequest !== request ||
                view.generation !== generation ||
                connection !== connectionAtStart ||
                identity() !== scope ||
                !view.refs ||
                !(await store.validTicket(view.key, result.ticket))
              )
                return;
              setCached(view, restoreTurns(pages));
              notify(id);
            })().catch(() => {});
          }
          const finish = () => {
            if (view?.olderRequest !== request) return;
            view.olderRequest = undefined;
            setCached(view);
            notify(id);
          };
          try {
            return Promise.resolve(
              originalOlder.call(this, id, ...args),
            ).finally(finish);
          } catch (error) {
            finish();
            throw error;
          }
        };
      }
      async function flush(view: View) {
        clearTimeout(view.timer);
        view.timer = undefined;
        if (
          view.writing ||
          view.reading ||
          !view.ticket ||
          !scope ||
          identity() !== scope ||
          disposed
        ) {
          finishInactive(view);
          return;
        }
        const state = manager.getConversation(view.id);
        // History pages can arrive before thread/resume finishes. Persisting
        // those display records does not make the backend session ready.
        if (!state) {
          finishInactive(view);
          return;
        }
        const turns = native.turns(state);
        if (!turns.length) {
          finishInactive(view);
          return;
        }
        view.pending = false;
        view.finalPending = false;
        view.writing = true;
        view.lastWrite = now();
        const generation = view.generation,
          connectionAtStart = connection,
          ticket = view.ticket;
        try {
          const keep: string[] = [],
            pages: CachePage[] = [];
          const saved = new Map<
            string,
            { items: any[]; details: any; order: number }
          >();
          let order = 0;
          for (const turn of turns) {
            if (typeof turn.turnId !== "string") continue; // Pending local submissions are not history.
            for (
              let offset = 0;
              offset < Math.max(1, turn.items.length);
              offset += 100
            ) {
              const id = `${turn.turnId}:page:${offset}`;
              keep.push(id);
              const items = turn.items.slice(offset, offset + 100),
                previous = view.saved.get(id);
              const unchanged =
                previous &&
                previous.order === order &&
                previous.items.length === items.length &&
                previous.items.every((item, index) => item === items[index]) &&
                [
                  "params",
                  "status",
                  "error",
                  "turnStartedAtMs",
                  "turnCompletedAtMs",
                  "itemsPagination",
                ].every((key) => previous.details[key] === turn[key]);
              if (!unchanged) {
                const page = await codec("encode", {
                  id,
                  order,
                  data: {
                    schema: 1,
                    turnId: turn.turnId,
                    offset,
                    total: turn.items.length,
                    details: turnDetails(turn),
                    metadata: {
                      title: state.title,
                      createdAt: state.createdAt,
                      updatedAt: state.updatedAt,
                    },
                    items,
                    boundary:
                      state.turnsPagination ??
                      state.turnHistory?.history?.islands,
                  },
                });
                pages.push(page);
              }
              saved.set(id, { items, details: turn, order: order++ });
              if (
                generation !== view.generation ||
                connectionAtStart !== connection ||
                identity() !== scope
              )
                return;
            }
          }
          if (!pages.length) return;
          const complete = native.complete(state);
          const next = await store.savePages(
            view.key,
            ticket,
            pages,
            keep,
            !complete,
          );
          if (
            generation === view.generation &&
            connectionAtStart === connection &&
            identity() === scope
          ) {
            view.ticket = next ?? ticket;
            if (next) {
              view.saved = saved;
              counts.writes++;
            } else counts.skipped++;
          }
        } catch (error) {
          counts.skipped++;
          const category =
            error instanceof Error ? error.name : "CacheEncodingError";
          errors[category] = (errors[category] ?? 0) + 1;
        } finally {
          view.writing = false;
          if (view.pending) schedule(view, view.finalPending);
          finishInactive(view);
        }
      }
      function schedule(view: View, final = false) {
        view.pending = true;
        view.finalPending = view.finalPending || final;
        if (final) {
          clearTimeout(view.timer);
          view.timer = undefined;
          void flush(view);
        } else if (!view.timer)
          view.timer = setTimeout(
            () => void flush(view),
            Math.max(0, 1000 - (now() - view.lastWrite)),
          );
      }
      const remove = async (id: string) => {
        const view = views.get(id);
        if (view) forget(view);
        if (scope) await store.invalidate(JSON.stringify([scope, id]));
      };
      const cleanups: Array<() => void> = [];
      cleanups.push(
        manager.addConversationStateCallback((id: string, state: any) => {
          const view = views.get(id);
          if (!view) return;
          if (!state) {
            void remove(id);
            return;
          }
          if (
            native.turns(state).length &&
            view.cached &&
            view.olderRequest == null
          ) {
            setCached(view);
            notify(id);
          }
          schedule(view);
        }),
      );
      cleanups.push(
        manager.addTurnCompletedListener(({ conversationId }: any) => {
          const view = views.get(conversationId);
          if (view) schedule(view, true);
        }),
      );
      cleanups.push(
        manager.addThreadDeletedListener((id: string) => void remove(id)),
      );
      for (const method of ["thread/reverted", "thread/compacted"]) {
        if (manager.addNotificationCallback)
          cleanups.push(
            manager.addNotificationCallback(method, ({ params }: any) => {
              const id = params?.threadId;
              if (typeof id === "string") void remove(id);
            }),
          );
      }
      // These are native mutation methods, not the shared request transport. Invalidate
      // before applying a rollback so queued snapshots cannot resurrect removed messages.
      for (const name of [
        "applyRollbackResponseToConversation",
        "applyRevertResponseToConversation",
      ]) {
        const original = manager[name];
        if (typeof original !== "function") continue;
        manager[name] = function (args: any, ...rest: any[]) {
          void remove(args.conversationId);
          return original.call(this, args, ...rest);
        };
        cleanups.push(() => {
          manager[name] = original;
        });
      }
      function identityChanged() {
        const next = identity();
        if (next === scope) return;
        if (next && verifiedScope && next !== verifiedScope)
          void store.invalidateScope(verifiedScope);
        if (next) verifiedScope = next;
        scope = next;
        for (const view of views.values()) {
          const key = view.key;
          forget(view);
          void store.release(key, view.lease);
          if (scope) {
            view.key = JSON.stringify([scope, view.id]);
            if (key !== view.key) void store.invalidate(key);
          }
          if (scope && view.refs) requestRead(view);
        }
      }
      cleanups.push(readState.subscribeStatus(identityChanged));
      identityChanged();
      const controller = {
        reset,
        enabled: () => {
          for (const view of views.values())
            if (view.refs && !view.ticket) {
              view.pending = true;
              requestRead(view);
            }
        },
        connection: () => {
          reset();
          for (const view of views.values()) if (view.refs) requestRead(view);
        },
      };
      controllers.add(controller);
      if (manager.addAuthStatusCallback && manager.removeAuthStatusCallback) {
        const authChanged = ({ authMethod }: any) => {
          const oldScope = scope || verifiedScope;
          hostAuthenticated = authMethod != null;
          reset();
          void store.invalidateScope(oldScope).then(() => {
            if (disposed) return;
            identityChanged();
            if (hostAuthenticated) controller.enabled();
          });
        };
        manager.addAuthStatusCallback(authChanged);
        cleanups.push(() => manager.removeAuthStatusCallback(authChanged));
      }
      const viewed = () => {
        if (
          typeof document !== "undefined" &&
          document.visibilityState === "hidden"
        )
          return;
        for (const view of views.values())
          if (view.refs && scope) void store.touch(view.key, view.lease);
      };
      globalThis.addEventListener?.("focus", viewed);
      globalThis.addEventListener?.("visibilitychange", viewed);
      const leaseTimer = setInterval(() => {
        identityChanged();
        for (const view of views.values())
          if (view.refs && scope) void store.touch(view.key, view.lease, false);
      }, 10000);
      return () => {
        disposed = true;
        clearInterval(leaseTimer);
        globalThis.removeEventListener?.("focus", viewed);
        globalThis.removeEventListener?.("visibilitychange", viewed);
        controllers.delete(controller);
        for (const view of views.values()) {
          forget(view);
          void store.release(view.key, view.lease);
        }
        for (const cleanup of cleanups) cleanup();
        subscriptions.subscribe = originalSubscribe;
        if (typeof originalOlder === "function")
          manager.loadOlderConversationTurnsPage = originalOlder;
        subscriptions.owner.getConversation = originalConversation;
        subscriptions.owner.getTranscript = originalTranscript;
        subscriptions.notifyTranscript = originalNotify;
      };
    },
  };
  return api;
}
export type ThreadCache = ReturnType<typeof createThreadCache>;
