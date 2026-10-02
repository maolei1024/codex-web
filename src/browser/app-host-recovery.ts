/** The facade keeps UI state alive, but never keeps a native RPC object across sessions. */
type Session = {
  services: PromiseLike<any>;
  close(): void;
  onBroken?(callback: () => void): void;
};
type Subscription = {
  path: string[];
  args: unknown[];
  generation: number;
  value?: any;
  active: boolean;
  attaching?: Promise<void>;
  onBroken?: (error: unknown) => void;
};
type Pending = {
  deadline: number;
  required: boolean;
  fail(error: Error): void;
};
export type RecoveryEvent = {
  generation: number;
  method: string;
  phase: string;
  elapsedMs: number;
  pending: number;
  reason: string;
};
export class RecoveryError extends Error {
  name = "CodexWebTransportError";
  constructor(
    public readonly method: string,
    public readonly reason: string,
  ) {
    super(
      reason === "timeout"
        ? "连接或读取超时，草稿已保留。"
        : "连接中断，草稿已保留。请检查操作结果后再重试。",
    );
  }
}

// Deliberately explicit: adding a service method does not make it replayable.
const READS = new Set([
  "settings.readAll",
  "settings.read",
  "startup.whenReady",
  "statsig.getStableId",
  "appInfo.get",
  "statsigEvaluations.readExecutionAssignments",
  "localThreadCatalog.readPage",
  "localThreadCatalog.readEntries",
  "localThreadCatalog.readStatus",
  "pinnedThreads.list",
]);
const NATIVE_READS = new Set([
  "config/read",
  "configRequirements/read",
  "model/list",
  "thread/read",
  "thread/resume",
]);
const SUBSCRIPTIONS = new Set([
  "projectFolderConsent.subscribe",
  "accessInputs.subscribe",
  "settings.subscribe",
  "terminal.subscribe",
  "inAppBrowserIncompleteNavigation.subscribe",
  "owlBrowserCrashCounter.subscribe",
  "localThreadCatalog.subscribeStatus",
  "localThreadCatalog.subscribeThreadObservations",
  "realtimeVoicePresentation.subscribe",
]);
export const STARTUP_FETCH_READS = new Set([
  "get-settings",
  "get-shared-object-snapshot",
  "get-global-state",
  "get-host-config",
  "get-workspace-roots",
  "get-remote-connections",
  "workspace-root-options",
  "codex-home",
  "app-server-connection-state",
  "locale-info",
]);

export class AppHostRecovery {
  generation = 0;
  private factory?: () => Session;
  private session?: Session;
  private current?: any;
  private properties = new Map<string, { service: boolean; value?: unknown }>();
  private connecting?: Promise<void>;
  private cycle?: {
    deadline: number;
    retries: number;
    waiting?: Promise<void>;
  };
  private retrying = 0;
  private requiredFailures = new Set<string>();
  private nativeThreads = new Map<string, string | undefined>();
  private exhausted = false;
  private pending = new Set<Pending>();
  private subscriptions = new Set<Subscription>();
  private catalogSources = new Map<string, unknown[]>();
  private events: RecoveryEvent[] = [];
  private stages: Record<string, { state: string; at: number }> = {};
  private onRestore = new Set<() => void>();
  private onDisconnect = new Set<() => void>();
  private facade: any;
  private changed?: (state: string, method: string) => void;
  private recoveryNeeded?: () => void;
  private initialSettings = false;
  private initialStartup = false;
  private everReady = false;
  private cycleTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly now = Date.now,
    private readonly requiresHistory = () => false,
    private readonly activeScope: () => {
      hostId: string;
      threadId?: string;
    } = () => ({ hostId: "local" }),
  ) {
    this.facade = this.proxy([]);
  }
  get failed() {
    return this.exhausted;
  }
  authenticationFailed() {
    this.exhausted = true;
    this.disconnect("authentication");
  }
  configure(
    factory: () => Session,
    changed?: (state: string, method: string) => void,
    recoveryNeeded?: () => void,
  ) {
    this.factory = factory;
    this.changed = changed;
    this.recoveryNeeded = recoveryNeeded;
  }
  onRestored(callback: () => void): () => void {
    this.onRestore.add(callback);
    return () => {
      this.onRestore.delete(callback);
    };
  }
  onDisconnected(callback: () => void): () => void {
    this.onDisconnect.add(callback);
    return () => {
      this.onDisconnect.delete(callback);
    };
  }
  diagnostics() {
    return {
      generation: this.generation,
      pending: this.pending.size,
      requiredPending: [...this.pending].filter((request) => request.required)
        .length,
      subscriptions: this.subscriptions.size,
      exhausted: this.exhausted,
      requiredFailures: [...this.requiredFailures],
      stages: { ...this.stages },
      events: this.events.slice(),
    };
  }
  observeNative(event: {
    method?: string;
    hostId?: string;
    id?: string | number;
    conversationId?: string;
    params?: { threadId?: string };
    type: string;
    durationMs?: number;
  }) {
    const phase = (
      {
        "config/read": "configuration",
        "configRequirements/read": "requirements",
        "model/list": "models",
        "thread/read": "history",
        "thread/resume": "history",
      } as Record<string, string>
    )[event.method ?? ""];
    if (
      !phase ||
      !["started", "completed", "failed", "timed-out"].includes(event.type)
    )
      return;
    this.record(
      event.method!,
      phase,
      this.now() - (event.durationMs ?? 0),
      event.type,
    );
    const key = JSON.stringify([event.hostId ?? "local", event.id]);
    const threadId =
      event.params?.threadId ??
      event.conversationId ??
      this.nativeThreads.get(key);
    if (event.type === "started" && event.id != null)
      this.nativeThreads.set(key, threadId);
    else this.nativeThreads.delete(key);
    // Desktop preloads other hosts and sidebar conversations during startup.
    // Their missing histories/authentication must fail only their own callers.
    if (!this.requiredNativeRead(event.method!, event.hostId, threadId)) return;
    // Native clients also report background reads and write preparation. Their
    // errors belong to the caller, not to a completed startup cycle. In
    // particular, an inactive thread read must not poison the next foreground
    // conversation or arm a new recovery deadline.
    if (this.everReady && !this.cycle) return;
    this.stages[phase] = { state: event.type, at: this.now() };
    if (["failed", "timed-out"].includes(event.type)) {
      this.requiredFailures.add(`${event.hostId ?? "local"}:${event.method}`);
      this.changed?.("failed", phase);
    } else if (event.type === "completed") {
      this.requiredFailures.delete(
        `${event.hostId ?? "local"}:${event.method}`,
      );
      this.maybeReady();
    }
  }
  private requiredNativeRead(
    method: string,
    hostId = "local",
    threadId?: string,
  ) {
    const scope = this.activeScope();
    return (
      hostId !== "durable" &&
      hostId === scope.hostId &&
      NATIVE_READS.has(method) &&
      (!method.startsWith("thread/") ||
        (this.requiresHistory() &&
          (scope.threadId == null || threadId === scope.threadId)))
    );
  }
  private maybeReady() {
    if (
      !this.initialSettings ||
      !this.initialStartup ||
      this.connecting ||
      this.retrying ||
      [...this.pending].some((request) => request.required) ||
      this.requiredFailures.size ||
      this.exhausted ||
      (this.requiresHistory() && this.stages.history?.state !== "completed") ||
      Object.values(this.stages).some((stage) => stage.state === "started") ||
      ["configuration", "requirements", "models"].some(
        (key) => this.stages[key]?.state !== "completed",
      )
    )
      return;
    this.changed?.("connected", "startup");
    this.everReady = true;
    clearTimeout(this.cycleTimer);
    this.cycle = undefined;
  }
  async nativeRequest<T>(
    method: string,
    operation: (timeoutMs?: number) => Promise<T>,
    hostId?: string,
    params?: { threadId?: string },
  ): Promise<T> {
    // Once ready, a read preparing a user write fails back to that caller. It
    // must never keep a pending send alive until a later automatic recovery.
    if (
      !this.requiredNativeRead(method, hostId, params?.threadId) ||
      (this.everReady && !this.cycle)
    )
      return operation();
    return this.retry(method, async () => {
      const cycle = this.budget();
      try {
        return await operation(Math.min(15_000, cycle.deadline - this.now()));
      } catch (error) {
        const failure = error as {
          code?: unknown;
          jsonRpcCode?: unknown;
          message?: string;
        };
        // These native scheduler errors mean the read was never dispatched.
        // They share the same finite recovery budget as a lost reply, rather
        // than making a temporary full queue permanently fail initialization.
        const queued =
          (failure?.code ?? failure?.jsonRpcCode) === -32001 &&
          [
            "App server request expired while queued",
            "App server request queue is full",
            "App server coalesced request queue is full",
          ].includes(failure?.message ?? "");
        if (
          queued ||
          (error as Error)?.name === "CodexWebTransportError" ||
          (error as Error)?.name === "AppServerRequestDeliveryError" ||
          (error as Error)?.name === "AppServerRequestTimeoutError"
        )
          throw new RecoveryError(method, "timeout");
        throw error;
      }
    });
  }
  private record(method: string, phase: string, start: number, reason = "") {
    this.events.push({
      generation: this.generation,
      method,
      phase,
      elapsedMs: this.now() - start,
      pending: this.pending.size,
      reason,
    });
    if (this.events.length > 200) this.events.shift();
    if (
      ["services", "settings.readAll", "startup.whenReady"].includes(method)
    ) {
      this.stages[method] = {
        state: phase === "end" ? reason : phase,
        at: this.now(),
      };
    }
  }
  private budget() {
    if (this.exhausted) {
      this.changed?.("failed", "services");
      throw new RecoveryError("services", "exhausted");
    }
    const cycle = this.beginCycle();
    if (this.now() >= cycle.deadline) {
      this.exhausted = true;
      this.changed?.("failed", "services");
      throw new RecoveryError("services", "timeout");
    }
    return cycle;
  }
  private beginCycle() {
    if (this.cycle) return this.cycle;
    this.cycle = { deadline: this.now() + 60_000, retries: 0 };
    clearTimeout(this.cycleTimer);
    this.cycleTimer = setTimeout(() => this.checkDeadlines(), 60_000);
    return this.cycle;
  }
  checkDeadlines() {
    for (const request of [...this.pending]) {
      if (request.deadline <= this.now())
        request.fail(new RecoveryError("services", "timeout"));
    }
    if (this.cycle && this.now() >= this.cycle.deadline) {
      this.exhausted = true;
      this.disconnect("timeout");
    }
  }
  private attempt<T>(
    method: string,
    operation: () => PromiseLike<T>,
    close: boolean,
    bounded = true,
    cancel?: () => void,
  ): Promise<T> {
    const generation = this.generation;
    const start = this.now();
    const deadline = bounded
      ? Math.min(start + 15_000, this.cycle?.deadline ?? Infinity)
      : Infinity;
    this.record(method, "begin", start);
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (error?: Error, value?: T) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(pending);
        this.record(
          method,
          "end",
          start,
          error
            ? error instanceof RecoveryError
              ? error.reason
              : "error"
            : "ok",
        );
        if (error) {
          cancel?.();
          if (close && error instanceof RecoveryError)
            this.disconnect(error.reason);
          reject(error);
        } else if (generation !== this.generation)
          reject(new RecoveryError(method, "stale"));
        else {
          if (method === "settings.readAll") this.initialSettings = true;
          if (method === "startup.whenReady") this.initialStartup = true;
          this.maybeReady();
          resolve(value as T);
        }
      };
      const pending: Pending = {
        deadline,
        required: bounded,
        fail: (error) =>
          finish(
            new RecoveryError(
              method,
              error instanceof RecoveryError ? error.reason : "disconnected",
            ),
          ),
      };
      const timer = Number.isFinite(deadline)
        ? setTimeout(
            () => pending.fail(new RecoveryError(method, "timeout")),
            Math.max(0, deadline - start),
          )
        : undefined;
      this.pending.add(pending);
      Promise.resolve()
        .then(() => {
          if (done || generation !== this.generation)
            throw new RecoveryError(method, "stale");
          return operation();
        })
        .then(
          (value) => finish(undefined, value),
          (error) => finish(error),
        );
    });
  }
  disconnect(reason = "disconnected") {
    const old = this.session;
    this.nativeThreads.clear();
    this.session = undefined;
    this.current = undefined;
    this.initialSettings = false;
    this.initialStartup = false;
    for (const key of ["configuration", "requirements", "models", "history"])
      if (this.stages[key])
        this.stages[key] = { state: "waiting", at: this.now() };
    if (!this.exhausted) this.beginCycle();
    // Invalidate callbacks before native abort can flush any final messages.
    if (old) this.generation++;
    // The WebSocket can remain open when only AppHost's MessagePort retires.
    // Native app-server replies are a separate lifetime from the IPC ACK;
    // settle them too, before the next session can reuse a pending resume.
    for (const callback of this.onDisconnect) callback();
    for (const request of [...this.pending])
      request.fail(new RecoveryError("services", reason));
    old?.close();
    for (const entry of this.subscriptions) {
      entry.value = undefined;
      entry.generation = -1;
    }
    this.changed?.(this.exhausted ? "failed" : "recovering", reason);
  }
  private connect(): Promise<void> {
    if (this.current) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const task = (async () => {
      const cycle = this.budget();
      if (!this.factory) throw new RecoveryError("services", "unavailable");
      this.changed?.("recovering", "services");
      this.generation++;
      const session = this.factory();
      this.session = session;
      session.onBroken?.(() => {
        if (this.session === session) {
          this.disconnect("disconnected");
          void Promise.resolve().then(() => this.recoveryNeeded?.());
        }
      });
      const current = await this.attempt(
        "services",
        () => session.services,
        true,
      );
      if (session !== this.session || this.now() >= cycle.deadline)
        throw new RecoveryError("services", "stale");
      this.current = current;
      this.properties = new Map(
        Object.entries(current).map(([key, value]) => [
          key,
          value != null &&
          (typeof value === "object" || typeof value === "function")
            ? { service: true }
            : { service: false, value },
        ]),
      );
      this.record("services", "connected", this.now());
      if (this.generation > 1) {
        for (const args of this.catalogSources.values())
          await this.invoke(["localThreadCatalog", "setSourceEnabled"], args);
        await Promise.all(
          [...this.subscriptions]
            .filter((entry) => entry.active)
            .map((entry) => this.attach(entry)),
        );
      }
    })();
    this.connecting = task;
    void task
      .finally(() => {
        if (this.connecting === task) this.connecting = undefined;
        this.maybeReady();
      })
      .catch(() => {});
    return task;
  }
  private async retry<T>(
    method: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.retrying++;
    try {
      for (;;) {
        // Routine reads/subscriptions continue after startup. Only an actual
        // disconnect (or initial startup) opens the shared recovery budget.
        // attempt() still bounds these reads and disconnects on transport loss.
        if (!this.everReady || this.cycle || !this.current) this.budget();
        try {
          return await operation();
        } catch (error) {
          if (this.everReady && !this.cycle && this.current) throw error;
          // Application/authorization errors must not turn into synthetic success.
          const cycle = this.budget();
          if (
            (!cycle.waiting && cycle.retries >= 2) ||
            this.now() >= cycle.deadline ||
            !(error instanceof RecoveryError)
          ) {
            this.exhausted = true;
            this.changed?.("failed", method);
            throw error;
          }
          if (!cycle.waiting) {
            const delay = [1_000, 3_000][cycle.retries++];
            this.record(method, "retry", this.now(), String(cycle.retries));
            cycle.waiting = new Promise<void>((resolve) =>
              setTimeout(resolve, delay),
            ).finally(() => {
              cycle.waiting = undefined;
            });
          }
          await cycle.waiting;
          this.budget();
        }
      }
    } finally {
      this.retrying--;
      this.maybeReady();
    }
  }
  async start() {
    await this.retry("services", () => this.connect());
    return this.facade;
  }
  async fetchRequest<T>(
    url: string,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
    body?: unknown,
  ): Promise<T> {
    const endpoint = url.startsWith("vscode://codex/")
      ? url.slice("vscode://codex/".length)
      : "fetch";
    const method = /^[a-z][a-z0-9-]{0,79}$/.test(endpoint) ? endpoint : "fetch";
    let hostId: unknown;
    try {
      const params = typeof body === "string" ? JSON.parse(body) : body;
      if (params && typeof params === "object" && "hostId" in params)
        hostId = params.hostId;
    } catch {
      // Invalid request bodies still fail through the original Desktop handler.
    }
    const readonly =
      STARTUP_FETCH_READS.has(method) &&
      (hostId == null || hostId === this.activeScope().hostId) &&
      hostId !== "durable";
    const run = () => {
      signal?.throwIfAborted();
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      return this.attempt(
        method,
        () => operation(controller.signal),
        false,
        readonly,
        () => controller.abort(new RecoveryError(method, "disconnected")),
      ).finally(() => signal?.removeEventListener("abort", abort));
    };
    return readonly ? this.retry(method, run) : run();
  }
  /** Only explicit user retry starts a new budget after exhaustion. */
  async recover(manual = false) {
    if (!this.factory) return;
    if (manual) {
      this.exhausted = false;
      clearTimeout(this.cycleTimer);
      this.cycle = undefined;
    }
    await this.retry("settings.readAll", async () => {
      await this.connect();
      await this.invoke(["settings", "readAll"], []);
      if (this.current?.startup)
        await this.invoke(["startup", "whenReady"], []);
      for (const entry of this.subscriptions)
        if (entry.active && entry.generation !== this.generation)
          await this.attach(entry);
    });
    for (const callback of this.onRestore) callback();
    this.maybeReady();
  }
  private native(path: string[]) {
    let receiver = this.current;
    for (const key of path.slice(0, -1)) receiver = receiver?.[key];
    return { receiver, callable: receiver?.[path.at(-1)!] };
  }
  private invoke(path: string[], args: unknown[]) {
    const method = path.join(".");
    const { receiver, callable } = this.native(path);
    if (!callable)
      return Promise.reject(new RecoveryError(method, "disconnected"));
    let raw: any;
    const brokenCallbacks = new Set<(error: unknown) => void>();
    const task = this.attempt(
      method,
      () => {
        raw = Reflect.apply(callable, receiver, args);
        for (const callback of brokenCallbacks) raw?.onRpcBroken?.(callback);
        return raw;
      },
      true,
      READS.has(method) ||
        SUBSCRIPTIONS.has(method) ||
        method === "localThreadCatalog.setSourceEnabled",
    );
    // Desktop explicitly disposes RpcPromises (including HTTP streaming calls).
    // Preserve that protocol instead of returning an incompatible bare Promise.
    Object.defineProperty(task, Symbol.dispose, {
      value: () => {
        raw?.[Symbol.dispose]?.();
      },
    });
    Object.defineProperty(task, "onRpcBroken", {
      value: (callback: (error: unknown) => void) => {
        let notified = false;
        const notify = (error: unknown) => {
          if (notified) return;
          notified = true;
          callback(error);
        };
        brokenCallbacks.add(notify);
        raw?.onRpcBroken?.(notify);
        void task.catch(notify).catch(() => {});
      },
    });
    return task;
  }
  private async attach(entry: Subscription) {
    if (!entry.active) return;
    if (entry.generation === this.generation) return entry.attaching;
    const generation = this.generation;
    entry.generation = generation;
    const args = entry.args.map((arg) =>
      typeof arg === "function"
        ? (...values: unknown[]) => {
            if (entry.active && generation === this.generation)
              return arg(...values);
          }
        : arg,
    );
    entry.attaching = (async () => {
      try {
        const value = await this.invoke(entry.path, args);
        if (!entry.active || generation !== this.generation) {
          if (entry.path[0] === "projectFolderConsent")
            void (value as any)?.unsubscribe?.().catch?.(() => {});
          (value as any)?.[Symbol.dispose]?.();
          return;
        }
        entry.value = value;
        (value as any)?.onRpcBroken?.((error: unknown) => {
          if (entry.active && generation === this.generation)
            entry.onBroken?.(error);
        });
      } catch (error) {
        if (entry.generation === generation) entry.generation = -1;
        throw error;
      }
    })();
    return entry.attaching;
  }
  private subscribe(path: string[], args: unknown[]) {
    const entry: Subscription = { path, args, active: true, generation: -1 };
    const brokenCallbacks = new Set<(error: unknown) => void>();
    const onRpcBroken = (callback: (error: unknown) => void) => {
      brokenCallbacks.add(callback);
      void task.catch(callback).catch(() => {});
    };
    entry.onBroken = (error) => {
      for (const callback of brokenCallbacks) callback(error);
    };
    this.subscriptions.add(entry);
    const dispose = () => {
      if (!entry.active) return;
      entry.active = false;
      this.subscriptions.delete(entry);
      if (entry.generation === this.generation) {
        try {
          if (path[0] === "projectFolderConsent")
            void entry.value?.unsubscribe?.().catch?.(() => {});
          entry.value?.[Symbol.dispose]?.();
        } catch {}
      }
    };
    const task = this.retry(path.join("."), async () => {
      await this.connect();
      await this.attach(entry);
    }).then(
      () => ({ unsubscribe: dispose, [Symbol.dispose]: dispose, onRpcBroken }),
      (error) => {
        dispose();
        throw error;
      },
    );
    void task.catch(() => {});
    // Desktop uses this pipelined RPC handle synchronously during effect cleanup.
    Object.defineProperty(task, "unsubscribe", { value: dispose });
    Object.defineProperty(task, Symbol.dispose, {
      value: path[0] === "projectFolderConsent" ? dispose : () => {},
    });
    Object.defineProperty(task, "onRpcBroken", { value: onRpcBroken });
    return task;
  }
  private proxy(path: string[]): any {
    const children = new Map<PropertyKey, any>();
    return new Proxy(() => {}, {
      get: (_target, key) => {
        if (key === "then" || typeof key === "symbol") return undefined;
        if (!path.length) {
          const property = this.properties.get(key);
          if (!property?.service) return property?.value;
        }
        if (!children.has(key)) children.set(key, this.proxy([...path, key]));
        return children.get(key);
      },
      apply: (_target, _receiver, args) => {
        const method = path.join(".");
        if (SUBSCRIPTIONS.has(method)) return this.subscribe(path, args);
        if (path.at(-1)?.startsWith("unsubscribe")) {
          const counterpart = path.at(-1)!.replace(/^unsubscribe/, "subscribe");
          for (const entry of this.subscriptions) {
            if (
              entry.path[0] === path[0] &&
              entry.path.at(-1) === counterpart
            ) {
              entry.active = false;
              this.subscriptions.delete(entry);
            }
          }
        }
        const task = READS.has(method)
          ? this.retry(method, async () => {
              await this.connect();
              return this.invoke(path, args);
            })
          : this.invoke(path, args); // Writes have exactly one delivery attempt.
        if (method === "localThreadCatalog.setSourceEnabled") {
          void task
            .then(() => {
              const key = JSON.stringify(args[0]);
              if (args[1]) this.catalogSources.set(key, args);
              else this.catalogSources.delete(key);
            })
            .catch(() => {});
        }
        void task.catch(() => {});
        if (!(Symbol.dispose in task))
          Object.defineProperty(task, Symbol.dispose, { value: () => {} });
        if (!("onRpcBroken" in task))
          Object.defineProperty(task, "onRpcBroken", {
            value: (callback: (error: unknown) => void) => {
              void task.catch(callback).catch(() => {});
            },
          });
        return task;
      },
    });
  }
}
