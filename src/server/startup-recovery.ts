type AssignmentSource = {
  identityEpoch: number;
  publication?: unknown;
  publications: unknown[];
  disposed: boolean;
  readExecutionAssignments(): Promise<unknown>;
  listeners: Set<() => void>;
};
type DisplayRead = {
  epoch: number;
  publication: unknown;
  pending?: Promise<unknown>;
  value?: unknown;
  ready: boolean;
  notified: boolean;
  retryAt?: number;
};
const displayReads = new WeakMap<AssignmentSource, DisplayRead>();
const reads = new WeakMap<object, Promise<unknown>>();
const viewGroups = new WeakMap<
  object,
  { views: Set<any>; remove: () => void }
>();
const VIEW_NOTIFICATIONS = new Set([
  "automationCapabilityEventReceived",
  "automationRunTriggeredEventReceived",
  "clientStatusChanged",
  "ipcConnectionReset",
  "threadStreamStateChanged",
  "threadStreamFollowingChanged",
  "threadStreamFollowingStatusRequested",
  "threadReadStateChanged",
  "threadArchived",
  "threadUnarchived",
  "threadQueuedFollowUpsChanged",
  "appConnectOAuthCallbackReceived",
  "invalidateQueryCache",
]);

/** Desktop has one primary renderer/IPC client. Multiplex its callbacks, not its identity. */
export function registerView(
  client: object,
  view: any,
  register: (view: any) => () => void,
) {
  let group = viewGroups.get(client);
  if (!group) {
    const views = new Set<any>();
    const readRole = async (candidate: any, params: any) => {
      const request = candidate.getThreadRole(params);
      let timer: ReturnType<typeof setTimeout>;
      try {
        return await Promise.race([
          request,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), 1_000);
          }),
        ]);
      } catch {
        return null;
      } finally {
        clearTimeout(timer!);
        request[Symbol.dispose]?.();
      }
    };
    const callbacks = new Proxy(
      {},
      {
        get(_target, method) {
          if (method === "getThreadRole")
            return async (params: any) => {
              const roles = await Promise.all(
                [...views].map((view) => readRole(view, params)),
              );
              return roles.includes("owner") ? "owner" : null;
            };
          if (method === "requestThreadFollower")
            return async (params: any) => {
              const candidates = [...views];
              const roles = await Promise.all(
                candidates.map((view) =>
                  readRole(view, {
                    hostId: params.hostId,
                    conversationId: params.request.params.conversationId,
                  }),
                ),
              );
              const owner = candidates.find(
                (_view, index) => roles[index] === "owner",
              );
              if (!owner || !views.has(owner))
                throw new Error("Thread owner is no longer connected");
              // Exactly one selected owner receives a mutation. Never fan it out.
              return await owner.requestThreadFollower(params);
            };
          if (!VIEW_NOTIFICATIONS.has(String(method))) return undefined;
          return async (params: unknown) => {
            await Promise.allSettled(
              [...views].map((view) => Promise.resolve(view[method](params))),
            );
          };
        },
      },
    );
    group = { views, remove: register(callbacks) };
    viewGroups.set(client, group);
  }
  const owned = group;
  owned.views.add(view);
  return () => {
    owned.views.delete(view);
    if (owned.views.size === 0 && viewGroups.get(client) === owned) {
      owned.remove();
      viewGroups.delete(client);
    }
  };
}
const events: {
  method: string;
  phase: string;
  elapsedMs: number;
  reason: string;
}[] = [];
function trace(method: string, phase: string, start = Date.now(), reason = "") {
  events.push({ method, phase, elapsedMs: Date.now() - start, reason });
  if (events.length > 200) events.shift();
}

/** This fallback is only used for conversation presentation, never authorization. */
export async function displayAssignments(
  source?: AssignmentSource,
): Promise<any> {
  if (!source || source.disposed) return null;
  let state = displayReads.get(source);
  const matches = (state: DisplayRead) =>
    state.epoch === source.identityEpoch &&
    state.publication === source.publications[0];
  // An uncancellable identity request stays single-flight even through retries.
  if (
    !state ||
    (!state.pending &&
      (!matches(state) ||
        (!state.ready && Date.now() >= (state.retryAt ?? Infinity))))
  ) {
    state = {
      epoch: source.identityEpoch,
      publication: source.publications[0],
      ready: false,
      notified: false,
    };
    displayReads.set(source, state);
    const entry = state;
    const started = Date.now();
    trace("settings.display.identity", "begin");
    entry.pending = Promise.resolve()
      .then(() => source.readExecutionAssignments())
      .then(
        (value) => {
          if (!source.disposed && matches(entry)) {
            entry.value = value;
            entry.ready = true;
          }
          trace(
            "settings.display.identity",
            "end",
            started,
            matches(entry) ? "ok" : "stale",
          );
          return entry.ready ? entry.value : null;
        },
        () => {
          entry.retryAt = Date.now() + 3_000;
          trace("settings.display.identity", "end", started, "error");
          return null;
        },
      )
      .finally(() => {
        entry.pending = undefined;
        if (entry.notified && !source.disposed) {
          // Native listeners re-read and perform the original identity/policy checks.
          for (const listener of source.listeners) listener();
        }
      });
  }
  if (state.ready && matches(state)) return state.value;
  if (!state.pending) return null;
  const entry = state;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      entry.notified = true;
      trace("settings.display", "fallback", Date.now(), "timeout");
      resolve(null);
    }, 1_000);
    entry.pending!.then((value) => {
      clearTimeout(timer);
      resolve(matches(entry) ? value : null);
    });
  });
}

export function singleFlight<T>(
  owner: object,
  read: () => Promise<T>,
): Promise<T> {
  const active = reads.get(owner);
  if (active) return active as Promise<T>;
  const start = Date.now();
  trace("settings.readAll", "received");
  const task = Promise.resolve().then(read);
  reads.set(owner, task);
  void task
    .then(
      () => trace("settings.readAll", "reply", start, "ok"),
      () => trace("settings.readAll", "reply", start, "error"),
    )
    .finally(() => {
      if (reads.get(owner) === task) reads.delete(owner);
    });
  return task;
}

export const startupRecovery = {
  registerView,
  displayAssignments,
  singleFlight,
  diagnostics: () => events.slice(),
  trace,
};
(globalThis as any).__CODEX_WEB_STARTUP__ = startupRecovery;
