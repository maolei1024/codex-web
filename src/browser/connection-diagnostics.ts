import {
  sanitizeDiagnosticRecord,
  trimDiagnosticPages,
} from "../server/diagnostic-records";
/** Local, bounded transport evidence. Never collect message bodies or arbitrary strings. */
type RecordValue = Record<string, unknown>;
export type DiagnosticInput = {
  buildId?: unknown;
  browser?: unknown;
  connection?: unknown;
  diagnostics?: unknown;
};
type ServerStatus =
  | "not-requested"
  | "fetching"
  | "ok"
  | "offline"
  | "timeout"
  | "authentication"
  | "http-error"
  | "invalid-response"
  | "network-error"
  | "unavailable";

const EVENT_TYPES = new Set([
  "page-hide",
  "page-show",
  "visibility-change",
  "online",
  "offline",
  "network-change",
  "resume",
  "suspend",
  "freeze",
  "socket-connect",
  "socket-open",
  "socket-close",
  "socket-retire",
  "recovery-start",
  "socket-error",
  "watchdog-timeout",
  "ping",
  "pong",
  "reconnect-scheduled",
  "reconnect-start",
  "manual-retry",
  "recovery-state",
  "authentication-failed",
  "probe-start",
  "probe-result",
  "export",
]);
const STATES = new Set([
  "connecting",
  "open",
  "closing",
  "closed",
  "disconnected",
  "connected",
  "recovering",
  "waiting-network",
  "paused",
  "resumed",
  "waiting",
  "failed",
  "suspended",
  "offline",
  "ready",
  "idle",
  "exhausted",
  "begin",
  "end",
  "retry",
  "started",
  "completed",
  "timed-out",
  "ok",
  "error",
  "configuration",
  "transport",
  "session",
  "synchronizing",
  "requirements",
  "models",
  "history",
  "received",
  "reply",
  "fallback",
]);
const REASONS = new Set([
  "open",
  "close",
  "error",
  "connect-timeout",
  "pong-timeout",
  "send-failed",
  "online",
  "offline",
  "hidden",
  "visible",
  "freeze",
  "resume",
  "pagehide",
  "pageshow",
  "manual",
  "retry",
  "heartbeat",
  "transport-timeout",
  "recovery-timeout",
  "timeout",
  "disconnected",
  "stale",
  "authentication",
  "exhausted",
  "unavailable",
  "disposed",
  "cancelled",
  "canceled",
  "ok",
  "started",
  "completed",
  "failed",
  "timed-out",
  "suspended",
  "network-change",
  "transport",
  "1",
  "2",
]);
const METHODS = new Set([
  "services",
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
  "threadReadState.getExecutionHostKeys",
  "appServerManagers.subscribe",
  "projectFolderConsent.subscribe",
  "accessInputs.subscribe",
  "settings.subscribe",
  "terminal.subscribe",
  "inAppBrowserIncompleteNavigation.subscribe",
  "owlBrowserCrashCounter.subscribe",
  "localThreadCatalog.subscribeStatus",
  "localThreadCatalog.subscribeThreadObservations",
  "realtimeVoicePresentation.subscribe",
  "config/read",
  "configRequirements/read",
  "model/list",
  "thread/read",
  "thread/resume",
  "settings.display.identity",
  "settings.display",
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
const CACHE_ERRORS = new Set([
  "StorageError",
  "CacheEncodingError",
  "Error",
  "TypeError",
  "QuotaExceededError",
  "InvalidStateError",
  "AbortError",
  "UnknownError",
  "SecurityError",
  "DataError",
  "NotFoundError",
  "VersionError",
  "TransactionInactiveError",
  "ConstraintError",
  "DataCloneError",
  "CodecUnavailable",
  "IndexedDBUnavailable",
  "IndexedDBTimeout",
]);
const STAGES = [
  "services",
  "settings.readAll",
  "startup.whenReady",
  "configuration",
  "requirements",
  "models",
  "history",
];
const MAX_SERVER_BYTES = 256 * 1024;

function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, Number.MAX_SAFE_INTEGER)
    : undefined;
}
function numbers(value: unknown, keys: string[]): RecordValue {
  const source = record(value),
    result: RecordValue = {};
  for (const key of keys) {
    const n = count(source[key]);
    if (n !== undefined) result[key] = n;
  }
  return result;
}
function booleans(source: RecordValue, result: RecordValue, keys: string[]) {
  for (const key of keys)
    if (typeof source[key] === "boolean") result[key] = source[key];
}
function choice(value: unknown, choices: Set<string>): string | undefined {
  return typeof value === "string"
    ? choices.has(value)
      ? value
      : "other"
    : undefined;
}
function buildId(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^(?:\d{2}\.\d{4}\.\d{4,6}-cli\d{3,8}-\d{8}-r\d{1,4}|development|test)$/.test(
      value,
    )
    ? value
    : undefined;
}
function eventDetails(value: unknown): RecordValue {
  const source = record(value);
  const result = numbers(source, [
    "generation",
    "attempt",
    "delayMs",
    "elapsedMs",
    "remainingMs",
    "code",
    "pending",
    "bufferedBytes",
  ]);
  booleans(source, result, ["wasClean", "persisted", "online", "suspended"]);
  for (const key of ["phase", "state", "status"]) {
    const state = choice(source[key], STATES);
    if (state !== undefined) result[key] = state;
  }
  const reason = choice(source.reason, REASONS);
  if (reason !== undefined) result.reason = reason;
  if (["hidden", "visible", "prerender"].includes(source.visibility as string))
    result.visibility = source.visibility;
  return result;
}
function trace(value: unknown): RecordValue {
  const source = record(value);
  const result = numbers(source, ["at", "generation", "elapsedMs", "pending"]);
  for (const [key, choices] of [
    ["method", METHODS],
    ["phase", STATES],
    ["reason", REASONS],
  ] as const) {
    const selected = choice(source[key], choices);
    if (selected !== undefined) result[key] = selected;
  }
  return result;
}
function traces(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.slice(-200).map(trace) : [];
}
function localDiagnostics(value: unknown): RecordValue {
  const source = record(value);
  const result = numbers(source, [
    "ports",
    "pendingInvokes",
    "pendingAppRequests",
    "sendQueue",
    "bufferedBytes",
  ]);
  const app = record(source.appHost);
  const appResult = numbers(app, [
    "generation",
    "pending",
    "requiredPending",
    "subscriptions",
    "remainingMs",
    "retries",
  ]);
  booleans(app, appResult, [
    "exhausted",
    "suspended",
    "executionBlocked",
    "authenticationRequired",
  ]);
  const admissionReasons = new Set([
    "hidden",
    "frozen",
    "offline",
    "transport",
    "startup",
    "recovery",
  ]);
  appResult.suspensionReason = choice(app.suspensionReason, admissionReasons);
  appResult.executionBlockReason = choice(
    app.executionBlockReason,
    admissionReasons,
  );
  appResult.cycle =
    app.cycle == null ? null : numbers(app.cycle, ["retries", "remainingMs"]);
  appResult.requiredFailures = Array.isArray(app.requiredFailures)
    ? [
        ...new Set(
          app.requiredFailures
            .slice(0, 64)
            .map((method) => choice(method, METHODS))
            .filter(Boolean),
        ),
      ]
    : [];
  const stages: RecordValue = {};
  for (const key of STAGES) {
    if (!record(app.stages)[key]) continue;
    const stage = record(record(app.stages)[key]);
    stages[key] = {
      ...numbers(stage, ["at"]),
      state: choice(stage.state, new Set([...STATES, ...REASONS])),
    };
  }
  appResult.stages = stages;
  appResult.events = traces(app.events);
  result.appHost = appResult;
  const cache = record(source.threadCache);
  const cacheResult = numbers(cache, [
    "hits",
    "misses",
    "writes",
    "skipped",
    "syncing",
    "maxCodecCopyMs",
  ]);
  const errors: RecordValue = {};
  // Unknown error text is never copied, including when used as an object key.
  for (const [key, value] of Object.entries(record(cache.errors)).slice(
    0,
    200,
  )) {
    const n = count(value);
    if (n === undefined) continue;
    const safeKey = CACHE_ERRORS.has(key) ? key : "other";
    errors[safeKey] = Math.min(
      Number.MAX_SAFE_INTEGER,
      ((errors[safeKey] as number) ?? 0) + n,
    );
  }
  cacheResult.errors = errors;
  result.threadCache = cacheResult;
  return result;
}
function browserState(value: unknown): RecordValue {
  const source = record(value),
    result: RecordValue = {};
  booleans(source, result, ["online", "cookieEnabled", "secureContext"]);
  if (["hidden", "visible", "prerender"].includes(source.visibility as string))
    result.visibility = source.visibility;
  const ua =
    typeof source.userAgent === "string" ? source.userAgent.slice(0, 1024) : "";
  const browser =
    /(?:Edg|EdgiOS|EdgA)\/(\d{1,5})/.exec(ua) ??
    /(?:Firefox|FxiOS)\/(\d{1,5})/.exec(ua) ??
    /(?:Chrome|CriOS)\/(\d{1,5})/.exec(ua) ??
    /Version\/(\d{1,5})[^\n]*Safari\//.exec(ua);
  result.family = browser
    ? /^(Edg)/.test(browser[0])
      ? "edge"
      : /^(Firefox|FxiOS)/.test(browser[0])
        ? "firefox"
        : /^(Chrome|CriOS)/.test(browser[0])
          ? "chrome"
          : "safari"
    : "unknown";
  if (browser) result.majorVersion = Number(browser[1]);
  result.mobile = /Mobile|Android|iPhone|iPad|iPod/.test(ua);
  const connection = record(source.network);
  const network = numbers(connection, ["rtt", "downlink"]);
  booleans(connection, network, ["saveData"]);
  if (
    ["slow-2g", "2g", "3g", "4g"].includes(connection.effectiveType as string)
  )
    network.effectiveType = connection.effectiveType;
  result.network = network;
  return result;
}
function serverDiagnostics(value: unknown): RecordValue {
  const source = record(value);
  if (
    count(source.connections) === undefined ||
    count(source.ports) === undefined
  )
    throw new Error("invalid-response");
  return {
    ...numbers(source, ["connections", "ports", "bufferedBytes"]),
    buildId: buildId(source.buildId),
    chunkedIpc: numbers(source.chunkedIpc, [
      "connections",
      "targets",
      "queuedMessages",
      "criticalQueuedMessages",
      "pendingTransfers",
      "oldestAckWaitMs",
      "oldestQueueWaitMs",
      "ackTimeouts",
    ]),
    startup: traces(source.startup),
    evidence: sanitizeServerEvidence(source.evidence),
  };
}
function sanitizeServerEvidence(value: unknown) {
  const source = record(value);
  return {
    ...numbers(source, [
      "capturedAt",
      "retentionMs",
      "dropped",
      "limit",
      "firstAt",
      "lastAt",
    ]),
    selected: source.selected === true,
    truncated: source.truncated === true,
    status: ["available", "missing"].includes(String(source.status))
      ? source.status
      : "missing",
    process: sanitizeDiagnosticRecord(source.process),
    connection: sanitizeDiagnosticRecord(source.connection),
    events: Array.isArray(source.events)
      ? source.events.slice(-500).map(sanitizeDiagnosticRecord)
      : [],
  };
}
async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_SERVER_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error("invalid-response");
  }
  if (!response.body) throw new Error("invalid-response");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let size = 0,
    text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_SERVER_BYTES) throw new Error("invalid-response");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createConnectionDiagnostics(
  options: {
    now?: () => number;
    maxEvents?: number;
    evidence?: () => unknown;
    onRecord?: (type: string, details: RecordValue) => void;
  } = {},
) {
  const now = options.now ?? Date.now;
  const limit = Math.max(
    1,
    Math.min(200, Math.trunc(options.maxEvents ?? 200) || 200),
  );
  const events: RecordValue[] = [];
  let droppedEvents = 0,
    generation = 0;
  let serverStatus: ServerStatus = "not-requested";
  let server: { capturedAt: number; diagnostics: RecordValue } | undefined;
  let trigger = "other";
  function snapshot(input: DiagnosticInput = {}) {
    const source = record(input.connection);
    const connection = {
      ...eventDetails(source),
      ...numbers(source, [
        "readyState",
        "reconnectAttempt",
        "consecutiveConnectFailures",
        "transportRemainingMs",
        "recoveryRemainingMs",
      ]),
    };
    booleans(source, connection, [
      "retryAvailable",
      "recovering",
      "suspended",
      "authenticationFailed",
    ]);
    return {
      schemaVersion: 2,
      capturedAt: now(),
      buildId: buildId(input.buildId),
      browser: browserState(input.browser),
      connection,
      diagnostics: localDiagnostics(input.diagnostics),
      droppedEvents,
      events: events.map((event) => ({ ...event })),
      evidence: options.evidence?.(),
      server: {
        status: serverStatus,
        trigger,
        ...(server
          ? {
              capturedAt: server.capturedAt,
              ageMs: Math.max(0, now() - server.capturedAt),
              stale: now() - server.capturedAt > 10_000,
              diagnostics: structuredClone(server.diagnostics),
            }
          : {}),
      },
    };
  }
  return {
    record(type: string, details?: unknown) {
      if (!EVENT_TYPES.has(type)) return;
      events.push({ at: now(), type, ...eventDetails(details) });
      try {
        options.onRecord?.(type, eventDetails(details));
      } catch {}
      if (events.length > limit) {
        events.shift();
        droppedEvents++;
      }
    },
    snapshot,
    serialize(input: DiagnosticInput = {}) {
      const report = snapshot(input);
      let text = JSON.stringify(report, null, 2);
      // Evidence has its own bounded rings; trim detail before dropping failures.
      const evidence = report.evidence as any;
      const limits = { limitBytes: 2 * 1024 * 1024, truncated: false };
      while (
        new TextEncoder().encode(text).length > limits.limitBytes &&
        evidence
      ) {
        limits.truncated = true;
        const pages = [...(evidence.previousPages ?? []), evidence];
        if (!trimDiagnosticPages(pages)) break;
        evidence.previousPages = pages.slice(0, -1);
        text = JSON.stringify({ ...report, exportLimits: limits }, null, 2);
      }
      return JSON.stringify({ ...report, exportLimits: limits }, null, 2);
    },
    clearServerSnapshot() {
      generation++;
      server = undefined;
      serverStatus = "not-requested";
    },
    async collect(
      input: DiagnosticInput = {},
      options: {
        fetch?: typeof fetch;
        online?: boolean;
        timeoutMs?: number;
        clientId?: string;
        trigger?: string;
      } = {},
    ) {
      const local = snapshot(input),
        request = ++generation;
      const fetcher = options.fetch ?? globalThis.fetch;
      if (options.online === false || !fetcher) {
        serverStatus = options.online === false ? "offline" : "unavailable";
        return { ...local, server: snapshot().server };
      }
      serverStatus = "fetching";
      trigger = [
        "open",
        "startup",
        "slow",
        "failure",
        "ready",
        "recovery",
      ].includes(options.trigger ?? "")
        ? options.trigger!
        : "other";
      const controller = new AbortController();
      let active = true,
        timer: ReturnType<typeof setTimeout> | undefined;
      const work = (async () => {
        try {
          const client =
            typeof options.clientId === "string" &&
            /^[a-f0-9-]{16,64}$/.test(options.clientId)
              ? `?clientId=${options.clientId}`
              : "";
          const response = await fetcher(`/__backend/diagnostics${client}`, {
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
          });
          if (!active || generation !== request) {
            void response.body?.cancel().catch(() => {});
            return;
          }
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            serverStatus =
              response.status === 401 || response.status === 403
                ? "authentication"
                : "http-error";
            if (serverStatus === "authentication") server = undefined;
            return;
          }
          let data: RecordValue;
          try {
            data = serverDiagnostics(
              await readBoundedJson(response, controller.signal),
            );
          } catch {
            if (active && generation === request)
              serverStatus = "invalid-response";
            return;
          }
          if (active && generation === request) {
            server = { capturedAt: now(), diagnostics: data };
            serverStatus = "ok";
          }
        } catch {
          if (active && generation === request) serverStatus = "network-error";
        }
      })();
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = setTimeout(
            () => {
              active = false;
              if (generation === request) serverStatus = "timeout";
              controller.abort();
              resolve();
            },
            Math.max(1, Math.min(5000, options.timeoutMs ?? 1500)),
          );
        }),
      ]);
      active = false;
      clearTimeout(timer);
      controller.abort();
      return { ...local, server: snapshot().server };
    },
  };
}
