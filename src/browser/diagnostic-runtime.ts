import { DiagnosticJournal } from "./diagnostic-journal";

const OPERATION = Symbol.for("codex-web.diagnostic.operation");
const WRITES = new Set([
  "turn/start",
  "turn/steer",
  "turn/addUserMessage",
  "thread/queue/add",
]);
/** Explicit UI objects and native request IDs carry causality across awaits. */
export class DiagnosticRuntime {
  clientId = "";
  private messages = new Map<string, string>();
  private native = new Map<
    string,
    {
      id: string;
      operationId?: string;
      method: string;
      sent: boolean;
      backendRejected?: boolean;
      hostId: string;
      threadId?: string;
    }
  >();
  private turns = new Map<string, string>();
  private recentResponses = new Set<string>();
  private failures = new WeakMap<object, string>();
  private projection = new Map<string, string>();
  private fetches = new Map<string, string>();
  private editorPending = false;
  private preparations = new Map<string, number>();
  constructor(
    readonly journal: DiagnosticJournal,
    private currentScope: () => {
      hostId?: string;
      threadId?: string;
    } = () => ({}),
  ) {}
  id(value: any): string | undefined {
    try {
      return value?.[OPERATION];
    } catch {
      return undefined;
    }
  }
  tag<T>(value: T, operationId?: string): T {
    try {
      if (
        operationId &&
        value &&
        (typeof value === "object" || typeof value === "function")
      )
        Object.defineProperty(value, OPERATION, {
          value: operationId,
          enumerable: true,
          configurable: true,
        });
    } catch {}
    return value;
  }
  start(value: unknown, mode = "ordinary") {
    const id = this.id(value) ?? this.journal.startOperation(mode);
    this.tag(value, id);
    return id;
  }
  step(
    id: string | undefined,
    phase: string,
    details: Record<string, unknown> = {},
    error?: unknown,
  ) {
    this.journal.step(id, phase, details, error);
  }
  identity(value: unknown) {
    this.journal.identityChanged(value);
  }
  retireIdentity() {
    this.journal.retireIdentity();
  }
  clear() {
    this.preparations.clear();
    this.messages.clear();
    this.native.clear();
    this.turns.clear();
    this.recentResponses.clear();
    this.fetches.clear();
    this.projection.clear();
    this.failures = new WeakMap();
  }
  bindMessage(messageId: unknown, operationId?: string) {
    if (messageId == null || !operationId) return;
    this.messages.set(this.journal.alias(messageId), operationId);
    while (this.messages.size > 500)
      this.messages.delete(this.messages.keys().next().value!);
  }
  operationForMessage(message: any): string | undefined {
    return (
      this.id(message?.submissionOptions) ??
      this.id(message) ??
      this.messages.get(
        this.journal.alias(typeof message === "object" ? message?.id : message),
      )
    );
  }
  preparationStart(message: unknown): string | undefined {
    const id = this.operationForMessage(message);
    if (!id) return;
    if (!this.preparations.has(id) && this.preparations.size >= 50) return;
    this.preparations.set(id, (this.preparations.get(id) ?? 0) + 1);
    this.step(id, "preparing", { preparationActive: true, outcome: "pending" });
    return id;
  }
  preparationEnd(id: string | undefined, error?: unknown) {
    if (!id || !this.preparations.has(id)) return;
    if (error != null) this.fail(id, error, "preparation");
    const count = this.preparations.get(id)! - 1;
    if (count > 0) {
      this.preparations.set(id, count);
      return;
    }
    this.preparations.delete(id);
    const writing = [...this.native.values()].some(
      (r) => r.operationId === id && WRITES.has(r.method),
    );
    this.step(id, "preparation-complete", {
      preparationActive: false,
      ...(writing || error != null ? {} : { outcome: "outcome-unknown" }),
    });
  }
  /** A closure carries only this caller's context through the native fetch facade. */
  fetcher<T extends (method: string, options?: any) => any>(
    fetch: T,
    operationId?: string,
  ): T {
    if (!operationId) return fetch;
    return ((method: string, options?: any) =>
      fetch(method, this.tag({ ...options }, operationId))) as T;
  }
  fetchStart(requestId: unknown, url: string, options: any) {
    const method = url.startsWith("vscode://codex/") ? url.slice(15) : "fetch";
    let params: any;
    try {
      params =
        typeof options?.body === "string"
          ? JSON.parse(options.body)
          : options?.body;
    } catch {}
    const id = this.journal.begin(method, {
      layer: "ipc",
      ...this.scope(params?.hostId, params?.threadId),
      operationId: this.id(options),
      requestId: this.journal.wireId(requestId, this.clientId),
      connectionId: this.journal.wireId("connection", this.clientId),
      parentId:
        options?.[Symbol.for("codex-web.diagnostic.request")] ??
        (method === "get-global-state"
          ? this.journal.wireId(params?.key, this.clientId)
          : undefined),
    });
    this.fetches.set(this.journal.alias(requestId), id);
    while (this.fetches.size > 1000)
      this.fetches.delete(this.fetches.keys().next().value!);
  }
  fetchEnd(requestId: unknown, error?: unknown, statusCode?: number) {
    const key = this.journal.alias(requestId),
      id = this.fetches.get(key);
    if (id) {
      this.fetches.delete(key);
      this.journal.end(id, error, { statusCode });
    }
  }
  scope(hostId: unknown, threadId?: unknown) {
    const current = this.currentScope();
    return {
      hostId: this.journal.alias(hostId ?? "local"),
      threadId: threadId == null ? undefined : this.journal.alias(threadId),
      hostType:
        hostId === "durable" || String(hostId).startsWith("cloud")
          ? "cloud"
          : !hostId || hostId === "local"
            ? "local"
            : "ssh",
      scope:
        (hostId ?? "local") === (current.hostId ?? "local") &&
        (threadId == null || threadId === current.threadId)
          ? "current"
          : "background",
    };
  }
  appHost = (
    phase: string,
    details: Record<string, any>,
    error?: unknown,
  ): string | undefined => {
    if (phase === "begin")
      return this.journal.begin(details.method, {
        ...details,
        ...this.scope(details.hostId, details.threadId),
        operationId: details.operationId,
      });
    if (phase === "end" && details.id) {
      this.journal.end(details.id, error, details);
      return;
    }
    if (phase === "progress" && details.id) {
      this.journal.progress(details.id, details);
      return;
    }
    if (phase === "stage") {
      const stage = ["begin", "end"].includes(details.phase)
        ? details.phase
        : details.reason;
      if (
        ["services", "settings.readAll", "startup.whenReady"].includes(
          details.method,
        )
      )
        this.journal.milestone(details.method, stage, {
          generation: details.generation,
          elapsedMs: details.elapsedMs,
          reason: details.reason,
        });
    }
  };
  registerNative(
    hostId: string,
    requestId: unknown,
    method: string,
    params: any,
    options: any,
  ) {
    const key = this.journal.alias(`${hostId}:${requestId}`);
    let operationId =
      this.id(options) ??
      this.id(params) ??
      this.messages.get(
        this.journal.alias(
          options?.clientUserMessageId ?? params?.clientUserMessageId,
        ),
      );
    if (!operationId && WRITES.has(method))
      operationId = this.journal.startOperation(
        method === "turn/steer"
          ? "steer"
          : method === "thread/queue/add"
            ? "follow-up"
            : "ordinary",
        { source: "rpc", ...this.scope(hostId, params?.threadId) },
      );
    const id = this.journal.begin(method, {
      layer: "rpc",
      operationId,
      requestId: this.journal.wireId(requestId, this.clientId),
      connectionId: this.journal.wireId("connection", this.clientId),
      ...this.scope(hostId, params?.threadId),
      optional: options?.codexWebOptionalRead === true,
      priority: options?.priority,
      remainingMs: options?.timeoutMs > 0 ? options.timeoutMs : null,
    });
    this.native.set(key, {
      id,
      method,
      operationId,
      sent: false,
      hostId: this.journal.alias(hostId),
      threadId:
        params?.threadId == null
          ? undefined
          : this.journal.alias(params.threadId),
    });
    while (this.native.size > 1000)
      this.native.delete(this.native.keys().next().value!);
    if (operationId)
      this.step(
        operationId,
        WRITES.has(method)
          ? "queued"
          : method.startsWith("thread/")
            ? "session"
            : "configuration",
        { method },
      );
  }
  nativeEvent(event: any) {
    if (event?.id == null) return;
    const key = this.journal.alias(`${event.hostId}:${event.id}`);
    const request = this.native.get(key);
    const details = {
      layer: "rpc",
      method: event.method,
      operationId: request?.operationId,
      requestId: this.journal.wireId(event.id, this.clientId),
      connectionId: this.journal.wireId("connection", this.clientId),
      ...this.scope(
        event.hostId,
        event.conversationId ?? event.params?.threadId,
      ),
      phase: event.type,
      queueWaitMs: event.queueWaitMs,
      elapsedMs: event.durationMs,
      priority: event.priority,
      optional: event.codexWebOptionalRead === true,
    };
    this.journal.record("requests", details);
    if (
      details.scope === "current" &&
      [
        "config/read",
        "configRequirements/read",
        "model/list",
        "thread/read",
        "thread/resume",
      ].includes(event.method)
    )
      this.journal.milestone(event.method, event.type, {
        ...details,
        elapsedMs: event.durationMs,
      });
    if (!request) return;
    if (["completed", "failed", "timed-out"].includes(event.type)) {
      this.native.delete(key);
      this.journal.end(request.id, event.error, details);
      if (request.operationId && WRITES.has(request.method)) {
        let outcome =
          event.type === "completed"
            ? request.method === "thread/queue/add"
              ? "queued"
              : "accepted"
            : event.error?.delivery?.stage === "not-sent" ||
                (!request.sent && event.type === "failed")
              ? "not-sent"
              : event.type === "timed-out" ||
                  [
                    "CodexWebTransportError",
                    "AppServerRequestDeliveryError",
                    "AppServerRequestTimeoutError",
                  ].includes(event.error?.name)
                ? "outcome-unknown"
                : request.backendRejected
                  ? "rejected-backend"
                  : "outcome-unknown";
        this.step(
          request.operationId,
          outcome,
          { outcome, method: request.method },
          event.error,
        );
        const turnId = event.result?.turn?.id ?? event.result?.turnId;
        if (turnId && outcome === "accepted") {
          const turnKey = this.journal.alias(`${event.hostId}:${turnId}`);
          if (this.recentResponses.delete(turnKey))
            this.step(request.operationId, "first-response", {
              outcome: "accepted",
            });
          else this.turns.set(turnKey, request.operationId);
          while (this.turns.size > 100)
            this.turns.delete(this.turns.keys().next().value!);
        }
      }
    }
  }
  backendReply(hostId: unknown, message: any) {
    const request = this.native.get(
      this.journal.alias(`${hostId}:${message?.id}`),
    );
    if (request) {
      request.sent = true;
      request.backendRejected = message?.error != null;
    }
  }
  delivered(
    hostId: unknown,
    requestId: unknown,
    phase: "dispatched" | "acknowledged",
  ) {
    const request = this.native.get(
      this.journal.alias(`${hostId}:${requestId}`),
    );
    if (!request) return;
    request.sent = true;
    this.journal.record("requests", {
      id: request.id,
      operationId: request.operationId,
      method: request.method,
      phase,
      layer: "ipc",
      sent: true,
    });
    if (WRITES.has(request.method))
      this.step(request.operationId, phase, {
        outcome: "outcome-unknown",
        sent: true,
      });
  }
  notification(hostId: unknown, method: unknown, params: any) {
    if (
      ![
        "item/started",
        "item/agentMessage/delta",
        "turn/completed",
        "error",
      ].includes(String(method))
    )
      return;
    const key = this.journal.alias(
      `${hostId}:${params?.turnId ?? params?.turn?.id}`,
    );
    const operationId = this.turns.get(key);
    if (!operationId) {
      this.recentResponses.add(key);
      while (this.recentResponses.size > 100)
        this.recentResponses.delete(
          this.recentResponses.values().next().value!,
        );
      return;
    }
    this.step(operationId, "first-response", { outcome: "accepted" });
    this.turns.delete(key);
  }
  fail(operationId: string | undefined, error: unknown, phase?: string) {
    if (error && typeof error === "object" && operationId)
      this.failures.set(error, operationId);
    this.journal.failOperation(operationId, phase, error);
    // Only the native delivery/response events establish a submitted outcome.
    this.journal.error(error, { operationId, phase, method: "submit" });
  }
  toast(error: unknown, options?: unknown) {
    const operationId =
      this.id(options) ??
      (error && typeof error === "object"
        ? this.failures.get(error)
        : undefined);
    this.journal.error(error, {
      operationId,
      method: "toast",
      layer: "browser",
    });
  }
  content(source: string, hostId?: string, threadId?: string) {
    const scope = this.scope(hostId, threadId);
    if (scope.scope !== "current") return;
    source =
      this.projection.get(this.journal.alias(`${hostId}:${threadId}`)) ??
      source;
    this.journal.milestone("content", source === "cache" ? "cache" : "live", {
      source,
      ...scope,
    });
  }
  projected(hostId: string, threadId: string, source: string) {
    this.projection.set(this.journal.alias(`${hostId}:${threadId}`), source);
    while (this.projection.size > 100)
      this.projection.delete(this.projection.keys().next().value!);
  }
  editor(element: HTMLElement) {
    if (this.editorPending || typeof MutationObserver === "undefined") return;
    this.editorPending = true;
    const ready = () => {
      if (!element.isConnected) return;
      observer.disconnect();
      clearTimeout(timeout);
      requestAnimationFrame(() => this.journal.milestone("editor", "ready"));
    };
    const observer = new MutationObserver(ready);
    const timeout = setTimeout(() => {
      observer.disconnect();
      this.editorPending = false;
    }, 30_000);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    ready();
  }
  disconnected() {
    for (const id of this.fetches.values())
      this.journal.end(id, new Error("Connection interrupted."));
    this.fetches.clear();
    for (const [key, req] of this.native) {
      this.journal.end(req.id, new Error("Connection interrupted."));
      if (WRITES.has(req.method))
        this.step(req.operationId, "disconnect", {
          outcome: req.sent ? "outcome-unknown" : "not-sent",
        });
      this.native.delete(key);
    }
  }
}

/** Diagnostic failures must never escape into a submit, RPC, or rendering path. */
export function diagnosticObserver(
  runtime: DiagnosticRuntime,
): DiagnosticRuntime {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(runtime, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      if (!methods.has(key))
        methods.set(key, (...args: unknown[]) => {
          try {
            return value.apply(target, args);
          } catch {
            return undefined;
          }
        });
      return methods.get(key);
    },
  });
}
