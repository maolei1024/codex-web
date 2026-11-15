import {
  DIAGNOSTIC_METHODS,
  DiagnosticRing,
  diagnosticAlias,
  diagnosticError,
  sanitizeDiagnosticRecord,
  type DiagnosticRecord,
} from "../server/diagnostic-records";

const TTL = 30 * 60_000;
const STORAGE_KEY = "codex-web-diagnostics-v2";
const STORAGE_LIMIT = 1024 * 1024;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Bucket = "requests" | "lifecycle" | "errors" | "performance";
const successful = new Set(["ok", "completed", "accepted", "ready"]);

/** One document's immutable milestones plus bounded, independently retained evidence. */
export class DiagnosticJournal {
  readonly pageId: string;
  private salt: string;
  private seq = 0;
  private start: number;
  private previous: number;
  private online = true;
  private hidden = false;
  private totals = { activeMs: 0, backgroundMs: 0, offlineMs: 0 };
  private rings = {
    requests: new DiagnosticRing(1000, TTL),
    lifecycle: new DiagnosticRing(200, TTL),
    errors: new DiagnosticRing(200, TTL),
    performance: new DiagnosticRing(200, TTL),
  };
  private milestones = new Map<string, DiagnosticRecord>();
  private operations = new Map<string, DiagnosticRecord>();
  private operationSteps = new DiagnosticRing(1600, TTL);
  private pending = new Map<string, DiagnosticRecord>();
  private pendingDropped = 0;
  private operationsDropped = 0;
  private recoveryStages = new Map<string, DiagnosticRecord>();
  private recoveryGeneration = -1;
  private previousPages: any[] = [];
  private storage?: StorageLike;
  private storageStatus = "memory";
  private persistenceTruncated = false;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private lastFlush = 0;
  private identity?: string;
  private capabilities = new Map<string, DiagnosticRecord>();
  private slowResources: DiagnosticRecord[] = [];
  private longTasks = { count: 0, totalElapsedMs: 0, maxElapsedMs: 0 };
  onActivity?: (failure: boolean) => void;
  onIdentityChanged?: () => void;
  private activity(failure: boolean) {
    try {
      this.onActivity?.(failure);
    } catch {}
  }
  constructor(
    private options: {
      now?: () => number;
      mono?: () => number;
      storage?: StorageLike;
      random?: () => string;
    } = {},
  ) {
    this.salt =
      options.random?.() ??
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random()}`;
    this.pageId = diagnosticAlias("page", this.salt);
    this.start = this.previous = this.mono();
    this.storage = options.storage;
    this.restore();
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private mono() {
    return (
      this.options.mono?.() ?? globalThis.performance?.now?.() ?? Date.now()
    );
  }
  alias(value: unknown) {
    return diagnosticAlias(value, this.salt);
  }
  wireId(value: unknown, clientId: string) {
    return diagnosticAlias(value, clientId);
  }
  private clock() {
    const now = this.mono(),
      elapsed = Math.max(0, now - this.previous);
    this.totals[
      this.hidden ? "backgroundMs" : !this.online ? "offlineMs" : "activeMs"
    ] += elapsed;
    this.previous = now;
    return {
      at: this.now(),
      mono: Math.max(0, now - this.start),
      ...this.totals,
    };
  }
  lifecycle(phase: string, details: Record<string, unknown> = {}) {
    const clock = this.clock();
    if (typeof details.online === "boolean") this.online = details.online;
    if (typeof details.hidden === "boolean") this.hidden = details.hidden;
    this.record("lifecycle", { phase, ...details, ...clock });
  }
  record(bucket: Bucket, details: Record<string, unknown>) {
    const value = sanitizeDiagnosticRecord({
      ...this.clock(),
      ...details,
      pageId: this.pageId,
      sequence: ++this.seq,
    });
    this.rings[bucket].push(value, this.now());
    if (bucket === "performance") {
      if (value.capability)
        this.capabilities.set(String(value.capability), value);
      if (value.method === "resource" || value.method === "navigation") {
        this.slowResources.push(value);
        this.slowResources.sort(
          (a, b) => Number(b.durationMs) - Number(a.durationMs),
        );
        this.slowResources.length = Math.min(30, this.slowResources.length);
      }
      if (value.method === "longtask") {
        this.longTasks.count++;
        this.longTasks.totalElapsedMs += Number(value.durationMs);
        this.longTasks.maxElapsedMs = Math.max(
          this.longTasks.maxElapsedMs,
          Number(value.durationMs),
        );
      }
    }
    this.scheduleFlush();
    if (bucket === "errors") this.activity(true);
    return value;
  }
  error(error: unknown, details: Record<string, unknown> = {}) {
    return this.record("errors", {
      ...details,
      ...diagnosticError(error, this.salt),
    });
  }
  milestone(
    method: string,
    phase: string,
    details: Record<string, unknown> = {},
  ) {
    const key = `${method}:${phase}`;
    const generation = Number(details.generation ?? this.recoveryGeneration);
    if (generation > this.recoveryGeneration) {
      this.recoveryStages.clear();
      this.recoveryGeneration = generation;
    }
    const clock = this.clock();
    const begin =
      this.recoveryStages.get(`${method}:begin`) ??
      this.recoveryStages.get(`${method}:started`);
    const record = sanitizeDiagnosticRecord({
      ...clock,
      pageId: this.pageId,
      method,
      phase,
      ...details,
      ...(["end", "completed", "failed", "timed-out"].includes(phase) && begin
        ? {
            elapsedMs: clock.mono - Number(begin.mono),
            activeElapsedMs: clock.activeMs - Number(begin.activeMs),
            backgroundElapsedMs:
              clock.backgroundMs - Number(begin.backgroundMs),
            offlineElapsedMs: clock.offlineMs - Number(begin.offlineMs),
          }
        : {}),
    });
    if (
      generation === this.recoveryGeneration &&
      this.recoveryStages.size < 100
    )
      this.recoveryStages.set(key, record);
    if (this.milestones.has(key) || this.milestones.size >= 100) return;
    this.milestones.set(key, record);
    this.scheduleFlush();
  }
  beginRecovery() {
    this.recoveryStages.clear();
    this.recoveryGeneration = -1;
  }
  begin(method: string, details: Record<string, unknown> = {}) {
    const id = this.alias(`request:${++this.seq}`);
    const stage = method.startsWith("config")
      ? "configuration"
      : method.startsWith("model")
        ? "models"
        : method.startsWith("thread/")
          ? "history"
          : method.startsWith("settings")
            ? "settings"
            : "app-host";
    const value = this.record("requests", {
      id,
      method,
      stage,
      methodId: DIAGNOSTIC_METHODS.has(method) ? undefined : this.alias(method),
      phase: "begin",
      ...details,
    });
    if (this.pending.size < 1000) this.pending.set(id, value);
    else this.pendingDropped++;
    this.activity(false);
    return id;
  }
  end(id: string, error?: unknown, details: Record<string, unknown> = {}) {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    const clock = this.clock();
    const value = this.record("requests", {
      ...pending,
      ...clock,
      id,
      reason: error == null ? "ok" : "error",
      elapsedMs: pending ? clock.mono - Number(pending.mono) : null,
      activeElapsedMs: pending
        ? clock.activeMs - Number(pending.activeMs)
        : null,
      backgroundElapsedMs: pending
        ? clock.backgroundMs - Number(pending.backgroundMs)
        : null,
      offlineElapsedMs: pending
        ? clock.offlineMs - Number(pending.offlineMs)
        : null,
      ...details,
      state: details.phase,
      phase: "end",
    });
    if (error != null) this.error(error, { ...value, phase: "end" });
  }
  startOperation(mode = "ordinary", details: Record<string, unknown> = {}) {
    const id = this.alias(`operation:${++this.seq}`);
    this.operations.set(
      id,
      sanitizeDiagnosticRecord({
        ...this.clock(),
        id,
        pageId: this.pageId,
        mode,
        phase: "clicked",
        outcome: "pending",
        ...details,
      }),
    );
    while (this.operations.size > 50) {
      this.operations.delete(this.operations.keys().next().value!);
      this.operationsDropped++;
    }
    this.step(id, "clicked", details);
    return id;
  }
  step(
    id: string | undefined,
    phase: string,
    details: Record<string, unknown> = {},
    error?: unknown,
  ) {
    if (!id || !this.operations.has(id)) return;
    const operation = this.operations.get(id)!;
    if (
      ["accepted", "queued", "rejected-backend"].includes(
        String(operation.outcome),
      ) &&
      ["pending", "not-sent", "outcome-unknown"].includes(
        String(details.outcome),
      )
    )
      details = { ...details, outcome: operation.outcome };
    const clock = this.clock();
    const record = sanitizeDiagnosticRecord({
      ...clock,
      pageId: this.pageId,
      operationId: id,
      phase,
      ...details,
    });
    this.operationSteps.push(record, this.now());
    Object.assign(
      operation,
      sanitizeDiagnosticRecord({
        phase,
        endAt: clock.at,
        elapsedMs: clock.mono - Number(operation.mono),
        ...details,
      }),
    );
    if (error != null)
      this.error(error, { operationId: id, phase, layer: "browser" });
    this.scheduleFlush();
    this.activity(error != null);
  }
  failOperation(
    id: string | undefined,
    phase: string | undefined,
    error: unknown,
  ) {
    const operation = id ? this.operations.get(id) : undefined;
    if (!operation) return;
    const outcome =
      operation.outcome === "pending" ? "not-sent" : operation.outcome;
    this.step(id, phase ?? String(operation.phase), { outcome }, error);
  }
  identityChanged(identity: unknown) {
    if (identity == null) return;
    const next = diagnosticAlias(identity, "opaque-backend-identity-v2");
    if (this.identity && this.identity !== next) this.retireIdentity();
    this.identity = next;
  }
  retireIdentity() {
    this.identity = undefined;
    this.previousPages = [];
    Object.values(this.rings).forEach((ring) => ring.clear());
    this.pending.clear();
    this.milestones.clear();
    this.operations.clear();
    this.operationSteps.clear();
    this.recoveryStages.clear();
    this.recoveryGeneration = -1;
    this.capabilities.clear();
    this.slowResources = [];
    this.longTasks = { count: 0, totalElapsedMs: 0, maxElapsedMs: 0 };
    this.pendingDropped = this.operationsDropped = 0;
    try {
      this.onIdentityChanged?.();
    } catch {}
    try {
      this.storage?.removeItem(STORAGE_KEY);
    } catch {
      /* diagnostic-only */
    }
  }
  pendingDetails() {
    const now = this.clock();
    return [...this.pending.values()].map((v) => ({
      ...v,
      elapsedMs: now.mono - Number(v.mono),
      activeElapsedMs: now.activeMs - Number(v.activeMs),
      remainingMs:
        typeof v.remainingMs === "number"
          ? Math.max(0, v.remainingMs - (now.activeMs - Number(v.activeMs)))
          : null,
    }));
  }
  hasSlowActivity() {
    const now = this.clock();
    return (
      [...this.pending.values()].some(
        (v) => now.mono - Number(v.mono) >= 3000,
      ) ||
      [...this.operations.values()].some(
        (v) => v.outcome === "pending" && now.mono - Number(v.mono) >= 3000,
      )
    );
  }
  private page() {
    const clock = this.clock();
    for (const [id, operation] of this.operations)
      if (clock.at - Number(operation.at) > TTL) {
        this.operations.delete(id);
        this.operationsDropped++;
      }
    const requests = this.rings.requests.snapshot(this.now());
    const byMethod = new Map<string, DiagnosticRecord>();
    for (const r of requests.events.filter((e) => e.phase === "end")) {
      const key = `${r.layer}:${r.method}`,
        a = byMethod.get(key) ?? {
          method: r.method,
          layer: r.layer,
          count: 0,
          errorCount: 0,
          totalElapsedMs: 0,
          maxElapsedMs: 0,
        };
      a.count = Number(a.count) + 1;
      a.errorCount =
        Number(a.errorCount) + (successful.has(String(r.reason)) ? 0 : 1);
      a.totalElapsedMs = Number(a.totalElapsedMs) + Number(r.elapsedMs ?? 0);
      a.maxElapsedMs = Math.max(
        Number(a.maxElapsedMs),
        Number(r.elapsedMs ?? 0),
      );
      byMethod.set(key, a);
    }
    const operations = [...this.operations.values()].map((v) => ({ ...v }));
    const recentTimeouts = this.rings.errors
      .snapshot(this.now())
      .events.filter(
        (e) => e.reason === "timeout" && clock.at - Number(e.at) <= 300_000,
      );
    const lastPong = this.rings.lifecycle
      .snapshot(this.now())
      .events.findLast((e) => e.phase === "pong");
    return {
      pageId: this.pageId,
      capturedAt: clock.at,
      startTime: this.start,
      durationMs: clock.mono,
      intervals: { ...this.totals },
      startup: [...this.milestones.values()].map((v) => ({ ...v })),
      pending: this.pendingDetails(),
      recovery: [...this.recoveryStages.values()].map((v) => ({ ...v })),
      completeness: {
        pending: {
          limit: 1000,
          dropped: this.pendingDropped,
          truncated: this.pendingDropped > 0,
        },
        operations: {
          limit: 50,
          dropped: this.operationsDropped,
          truncated: this.operationsDropped > 0,
          firstAt: operations[0]?.at ?? null,
          lastAt: operations.at(-1)?.at ?? null,
        },
        startup: { supported: true, independent: true },
        serverCorrelation: !!this.onActivity,
      },
      businessHealth: {
        recentTimeoutCount: recentTimeouts.length,
        lastPongAt: lastPong?.at ?? null,
        heartbeatWithBusinessTimeouts:
          !!lastPong &&
          recentTimeouts.some(
            (e) => Math.abs(Number(e.at) - Number(lastPong.at)) < 30_000,
          ),
        lastTimeoutAt: recentTimeouts.at(-1)?.at ?? null,
        cause: "unknown",
      },
      requests,
      lifecycle: this.rings.lifecycle.snapshot(this.now()),
      errors: this.rings.errors.snapshot(this.now()),
      performance: this.rings.performance.snapshot(this.now()),
      operations,
      performanceSummary: {
        capabilities: [...this.capabilities.values()].map((v) => ({ ...v })),
        slowestResources: this.slowResources.map((v) => ({ ...v })),
        longTasks: { ...this.longTasks },
      },
      operationSteps: this.operationSteps.snapshot(this.now()),
      requestSummary: [...byMethod.values()],
    };
  }
  snapshot() {
    this.previousPages = this.previousPages.filter(
      (p) => this.now() - p.capturedAt <= TTL,
    );
    return {
      ...this.page(),
      previousPages: structuredClone(this.previousPages),
      retentionMs: TTL,
      storage: {
        status: this.storageStatus,
        truncated: this.persistenceTruncated,
        limitBytes: STORAGE_LIMIT,
      },
    };
  }
  private scheduleFlush() {
    if (!this.storage || this.flushTimer) return;
    this.flushTimer = setTimeout(
      () => {
        this.flushTimer = undefined;
        this.flush();
      },
      Math.max(250, 2000 - (this.now() - this.lastFlush)),
    );
  }
  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.storage) return;
    this.lastFlush = this.now();
    const pages = [
      ...this.previousPages.filter((p) => this.now() - p.capturedAt <= TTL),
      this.page(),
    ];
    let text = JSON.stringify({
      version: 2,
      savedAt: this.now(),
      identity: this.identity,
      pages,
    });
    while (new TextEncoder().encode(text).length > STORAGE_LIMIT) {
      this.persistenceTruncated = true;
      if (pages.length > 1) pages.shift();
      else {
        const page = pages[0];
        const bucket = [
          page.requests,
          page.performance,
          page.lifecycle,
          page.operationSteps,
          page.errors,
        ].find((b) => b.events.length);
        if (!bucket) break;
        const removed = bucket.events.splice(
          0,
          Math.max(1, Math.ceil(bucket.events.length / 4)),
        );
        bucket.dropped += removed.length;
        bucket.truncated = true;
      }
      text = JSON.stringify({
        version: 2,
        savedAt: this.now(),
        identity: this.identity,
        pages,
      });
    }
    try {
      this.storage.setItem(STORAGE_KEY, text);
      this.storageStatus = "available";
    } catch {
      this.storageStatus = "quota";
      this.storage = undefined;
    }
  }
  private restore() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) {
        this.storageStatus = "available";
        return;
      }
      if (raw.length > STORAGE_LIMIT) throw new Error();
      const saved = JSON.parse(raw);
      if (saved.version !== 2 || !Array.isArray(saved.pages)) throw new Error();
      this.identity = sanitizeDiagnosticRecord({ id: saved.identity }).id as
        | string
        | undefined;
      if (
        this.now() - saved.savedAt > TTL ||
        saved.savedAt > this.now() + 60_000
      ) {
        this.storage.removeItem(STORAGE_KEY);
        this.storageStatus = "expired";
        return;
      }
      // Treat browser storage as untrusted: rebuild every retained record.
      this.previousPages = saved.pages
        .slice(-10)
        .filter(
          (p: any) =>
            typeof p.capturedAt === "number" &&
            this.now() - p.capturedAt <= TTL,
        )
        .map((p: any) => {
          const out: any = {
            pageId: sanitizeDiagnosticRecord({ pageId: p.pageId }).pageId,
            capturedAt: p.capturedAt,
          };
          out.intervals = sanitizeDiagnosticRecord(p.intervals);
          out.performanceSummary = {
            capabilities: Array.isArray(p.performanceSummary?.capabilities)
              ? p.performanceSummary.capabilities
                  .slice(0, 10)
                  .map(sanitizeDiagnosticRecord)
              : [],
            slowestResources: Array.isArray(
              p.performanceSummary?.slowestResources,
            )
              ? p.performanceSummary.slowestResources
                  .slice(0, 30)
                  .map(sanitizeDiagnosticRecord)
              : [],
            longTasks: sanitizeDiagnosticRecord(
              p.performanceSummary?.longTasks,
            ),
          };
          out.durationMs = sanitizeDiagnosticRecord(p).durationMs;
          for (const key of [
            "startup",
            "recovery",
            "operations",
            "pending",
            "requestSummary",
          ])
            out[key] = Array.isArray(p[key])
              ? p[key]
                  .slice(-(key === "pending" ? 1000 : 100))
                  .map(sanitizeDiagnosticRecord)
              : [];
          out.completeness = {
            pending: sanitizeDiagnosticRecord(p.completeness?.pending),
            operations: sanitizeDiagnosticRecord(p.completeness?.operations),
          };
          for (const key of [
            "requests",
            "lifecycle",
            "errors",
            "performance",
            "operationSteps",
          ]) {
            const events = Array.isArray(p[key]?.events)
              ? p[key].events
                  .slice(
                    -(key === "requests"
                      ? 1000
                      : key === "operationSteps"
                        ? 1600
                        : 200),
                  )
                  .map(sanitizeDiagnosticRecord)
              : [];
            out[key] = {
              events,
              dropped: Number.isFinite(p[key]?.dropped)
                ? Math.max(0, p[key].dropped)
                : 0,
              truncated: p[key]?.truncated === true,
              firstAt: events[0]?.at ?? null,
              lastAt: events.at(-1)?.at ?? null,
            };
          }
          return out;
        });
      this.storageStatus = "restored";
    } catch {
      this.storageStatus = "corrupt";
      try {
        this.storage.removeItem(STORAGE_KEY);
      } catch {
        this.storage = undefined;
      }
    }
  }
  dispose() {
    this.flush();
    clearTimeout(this.flushTimer);
  }
}
