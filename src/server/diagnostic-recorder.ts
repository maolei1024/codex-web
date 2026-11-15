import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  DiagnosticRing,
  diagnosticAlias,
  diagnosticError,
  sanitizeDiagnosticRecord,
  type DiagnosticRecord,
} from "./diagnostic-records";

type ConnectionEvidence = {
  ring: DiagnosticRing;
  clientId: string;
  closed: boolean;
  lastAt: number;
  queuePeak: number;
  lastResponseAt: number;
  starts: Map<string, { at: number; method: string }>;
};
/** Bounded process memory only. No payload, file, hostname, or credential is retained. */
export class ServerDiagnosticRecorder {
  private connections = new Map<string, ConnectionEvidence>();
  private loop = monitorEventLoopDelay({ resolution: 100 });
  private processStart = performance.now();
  constructor() {
    this.loop.enable();
  }
  private trim() {
    for (const [id, value] of this.connections) {
      value.ring.trim(Date.now());
      for (const [key, start] of value.starts)
        if (performance.now() - start.at > 300_000) value.starts.delete(key);
      if (value.closed && Date.now() - value.lastAt > 300_000)
        this.connections.delete(id);
    }
    while (this.connections.size > 16)
      this.connections.delete(this.connections.keys().next().value!);
  }
  open(clientId: string) {
    this.trim();
    this.connections.set(clientId, {
      clientId,
      ring: new DiagnosticRing(500, 300_000),
      closed: false,
      lastAt: Date.now(),
      queuePeak: 0,
      lastResponseAt: 0,
      starts: new Map(),
    });
    this.trim();
  }
  close(clientId: string) {
    this.record(clientId, { phase: "close" });
    const c = this.connections.get(clientId);
    if (c) c.closed = true;
  }
  alias(value: unknown, clientId: string) {
    return diagnosticAlias(value, clientId);
  }
  record(clientId: string, details: Record<string, unknown>, error?: unknown) {
    const connection = this.connections.get(clientId);
    if (!connection) return;
    connection.lastAt = Date.now();
    if (typeof details.queuedMessages === "number")
      connection.queuePeak = Math.max(
        connection.queuePeak,
        details.queuedMessages + Number(details.criticalQueuedMessages ?? 0),
      );
    if (
      details.phase === "reply" &&
      error == null &&
      details.successful === true
    )
      connection.lastResponseAt = Date.now();
    connection.ring.push({
      at: Date.now(),
      mono: performance.now() - this.processStart,
      connectionId: this.alias("connection", clientId),
      ...details,
      ...(error == null ? {} : diagnosticError(error, clientId)),
    });
  }
  request(
    clientId: string,
    event: any,
    phase: string,
    ipcId?: string,
    error?: unknown,
  ) {
    if (!event || typeof event !== "object") return;
    const requestId =
      event.request?.id ?? event.message?.id ?? event.requestId ?? event.id;
    if (requestId == null) return;
    let method =
      event.request?.method ??
      (typeof event.url === "string" && event.url.startsWith("vscode://codex/")
        ? event.url.slice(15)
        : (event.method ?? "other"));
    const connection = this.connections.get(clientId);
    const key = this.alias(requestId, clientId);
    if (phase === "received" && connection) {
      connection.starts.set(key, {
        at: performance.now(),
        method: String(sanitizeDiagnosticRecord({ method }).method),
      });
    }
    const start = connection?.starts.get(key);
    const handlerKey = `handler:${key}`;
    if (method === "other" && start) method = start.method;
    if (phase === "begin")
      connection?.starts.set(handlerKey, {
        at: performance.now(),
        method: String(sanitizeDiagnosticRecord({ method }).method),
      });
    const handlerStart = connection?.starts.get(handlerKey);
    if (phase === "end") connection?.starts.delete(handlerKey);
    if (phase === "reply") connection?.starts.delete(key);
    if (connection)
      while (connection.starts.size > 1000)
        connection.starts.delete(connection.starts.keys().next().value!);
    this.record(
      clientId,
      {
        requestId: key,
        parentId: ipcId == null ? undefined : this.alias(ipcId, clientId),
        method,
        layer: event.request || event.type === "mcp-response" ? "rpc" : "ipc",
        phase,
        hostId:
          event.hostId == null ? undefined : this.alias(event.hostId, clientId),
        threadId:
          event.request?.params?.threadId == null
            ? undefined
            : this.alias(event.request.params.threadId, clientId),
        elapsedMs: start == null ? undefined : performance.now() - start.at,
        handlerMs:
          phase === "end" && handlerStart != null
            ? performance.now() - handlerStart.at
            : undefined,
        successful:
          phase === "reply" &&
          event.responseType !== "error" &&
          event.error == null &&
          event.message?.error == null &&
          (event.status == null || event.status < 400),
        statusCode: typeof event.status === "number" ? event.status : undefined,
      },
      error,
    );
  }
  snapshot(clientId?: string) {
    this.trim();
    const connection = clientId ? this.connections.get(clientId) : undefined;
    const cpu = process.cpuUsage(),
      memory = process.memoryUsage();
    const report = {
      capturedAt: Date.now(),
      retentionMs: 300_000,
      selected: !!clientId,
      status: connection ? "available" : "missing",
      ...(connection?.ring.snapshot() ?? {
        events: [],
        dropped: 0,
        limit: 500,
        firstAt: null,
        lastAt: null,
      }),
      process: sanitizeDiagnosticRecord({
        cpuUserMs: cpu.user / 1000,
        cpuSystemMs: cpu.system / 1000,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        eventLoopMeanMs: Number.isFinite(this.loop.mean)
          ? this.loop.mean / 1e6
          : null,
        eventLoopMaxMs: this.loop.max / 1e6,
      }),
      connection: sanitizeDiagnosticRecord(
        connection
          ? {
              connectionId: this.alias("connection", clientId!),
              state: connection.closed ? "closed" : "open",
              queuePeak: connection.queuePeak,
              lastResponseAt: connection.lastResponseAt,
            }
          : {},
      ),
    };
    // Leave room for legacy counters/traces in the existing 256 KiB HTTP limit.
    while (
      Buffer.byteLength(JSON.stringify(report)) > 192 * 1024 &&
      report.events.length
    ) {
      const removed = report.events.splice(
        0,
        Math.max(1, Math.ceil(report.events.length / 4)),
      );
      report.dropped += removed.length;
    }
    return { ...report, truncated: report.dropped > 0 };
  }
  dispose() {
    this.loop.disable();
    this.connections.clear();
  }
}
