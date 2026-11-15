/** Shared, payload-free diagnostic vocabulary. This module has no platform imports. */
export const DIAGNOSTIC_METHODS = new Set(
  `services settings.readAll settings.read startup.whenReady statsig.getStableId appInfo.get statsigEvaluations.readExecutionAssignments localThreadCatalog.readPage localThreadCatalog.readEntries localThreadCatalog.readStatus localThreadCatalog.setSourceEnabled pinnedThreads.list threadReadState.getExecutionHostKeys appServerManagers.subscribe appServerManagers.openAccount projectFolderConsent.subscribe accessInputs.subscribe settings.subscribe terminal.subscribe inAppBrowserIncompleteNavigation.subscribe owlBrowserCrashCounter.subscribe localThreadCatalog.subscribeStatus localThreadCatalog.subscribeThreadObservations realtimeVoicePresentation.subscribe config/read configRequirements/read model/list account/read thread/list thread/read thread/resume thread/start thread/queue/add turn/addUserMessage turn/start turn/steer turn/interrupt command/exec get-settings get-shared-object-snapshot get-global-state set-global-state get-host-config get-workspace-roots get-remote-connections workspace-root-options codex-home app-server-connection-state locale-info read-file-binary read-file-metadata upload-local-file-over-sftp queued-follow-up-send-lock-acquire queued-follow-up-send-lock-release httpFetch fetch upload binary-read shared-object feature-config settings.display.identity settings.display startup configuration requirements models history editor content socket app-host statsig renderer navigation resource longtask paint submit toast runtime identity`.split(
    " ",
  ),
);
const VALUES = new Set(
  `app-host history requirements GET POST PUT DELETE PATCH HEAD caller deadline models settings late-response socket-error background interactive visibility socket-connect socket-open socket-close socket-retire recovery-start recovery-state page-show page-hide visibility-change network-change online offline resume suspend freeze ping pong watchdog-timeout reconnect-scheduled reconnect-start manual-retry authentication-failed probe-start probe-result export other unknown local ssh cloud current background none memory available unavailable failed unsupported quota corrupt expired truncated restored online offline hidden visible frozen connecting connected recovering waiting-network paused suspended resumed ready open closed begin end started completed received dispatched acknowledged accepted rejected not-sent outcome-unknown canceled cancelled timeout timed-out error ok retry queued blocked preparing attachments configuration session transport first-response unlocked locked clicked ordinary follow-up steer direct-comment start reply enqueue dequeue chunk ack close disconnect response rendering cache live authentication permission rate-limit queue-full queue-expired network abort validation internal resource-load unhandled-rejection uncaught-exception critical normal inline lifecycle requests errors operations milestones performance server apphost rpc ipc http browser initial recovery fetching not-requested invalid-response http-error network-error export slow failure startup unknown-error Error TypeError RangeError ReferenceError SyntaxError AbortError SecurityError QuotaExceededError CodexWebTransportError AppServerRequestDeliveryError AppServerRequestTimeoutError ECONNRESET ECONNREFUSED ETIMEDOUT ENOTFOUND EACCES ENOENT EPIPE HTTP1 HTTP2 HTTP3 h2 h3 http/1.1 script css font image document xmlhttprequest fetch mark measure first-paint first-contentful-paint resourceTiming navigationTiming longTasks statsig-cache-hit statsig-cache-miss statsig-network-deferred statsig-start statsig-ready statsig-failed statsig-refresh-start statsig-refresh-succeeded statsig-refresh-failed statsig-refresh-exhausted primary ready-state settings startup-read route inactive active retained missing rejected-backend complete pending interrupted`.split(
    " ",
  ),
);
const TEXT = new Set([
  "连接或读取超时，草稿已保留。",
  "连接中断，草稿已保留。请检查操作结果后再重试。",
  "Configuration read timed out. Your draft has been kept.",
  "Connection interrupted.",
  "App server request expired while queued",
  "App server request queue is full",
  "App server coalesced request queue is full",
  "Timeout",
  "Failed to fetch",
  "fetch failed",
  "未分类错误；自由文本已省略",
  "认证失败",
  "权限不足",
  "请求过多",
  "请求已取消",
]);
export type DiagnosticRecord = Record<string, string | number | boolean | null>;
const NUMBERS = new Set(
  `connections targets limit firstAt lastAt at mono sequence generation attempt elapsedMs activeMs activeElapsedMs backgroundElapsedMs offlineElapsedMs backgroundMs offlineMs startAt endAt startMono endMono durationMs remainingMs pending requiredPending count dropped bytes encodedBytes decodedBytes transferBytes statusCode code line column queuedMessages criticalQueuedMessages pendingTransfers oldestAckWaitMs oldestQueueWaitMs queuePeak ackTimeouts queueWaitMs handlerMs ackWaitMs lastResponseAt cpuUserMs cpuSystemMs rssBytes heapUsedBytes eventLoopMeanMs eventLoopMaxMs ttfbMs downloadMs dnsMs connectMs tlsMs responseMs startTime responseStart responseEnd requestStart domInteractive loadEventEnd domContentLoadedEventEnd longTaskMs ageMs deadlineMs portCount sendQueue bufferedBytes retryCount maxElapsedMs totalElapsedMs errorCount timeoutCount matchedRequests totalRequests`.split(
    " ",
  ),
);
const ENUMS = new Set(
  `kind layer method phase stage httpMethod cancelSource reason state outcome mode scope hostType source errorName errorCode priority category initiatorType protocol capability storageStatus`.split(
    " ",
  ),
);
const IDS = new Set(
  `id pageId operationId requestId parentId connectionId hostId threadId fingerprint methodId documentId`.split(
    " ",
  ),
);
const BOOLS = new Set(
  `required optional locked online hidden suspended current startup fromCache supported truncated sent explicit retryable successful persisted selected browserEstimate`.split(
    " ",
  ),
);
export function sanitizeDiagnosticRecord(input: unknown): DiagnosticRecord {
  const out: DiagnosticRecord = {};
  if (!input || typeof input !== "object") return out;
  for (const [key, value] of Object.entries(input).slice(0, 100)) {
    if (NUMBERS.has(key) && typeof value === "number" && Number.isFinite(value))
      out[key] = Math.max(
        key === "code" ? -1e9 : 0,
        Math.min(value, Number.MAX_SAFE_INTEGER),
      );
    else if (BOOLS.has(key) && typeof value === "boolean") out[key] = value;
    else if (ENUMS.has(key) && typeof value === "string")
      out[key] = (key === "method" ? DIAGNOSTIC_METHODS : VALUES).has(value)
        ? value
        : "other";
    else if (
      IDS.has(key) &&
      typeof value === "string" &&
      /^d-[a-f0-9]{8,32}$/.test(value)
    )
      out[key] = value;
    else if (key === "message" && typeof value === "string" && TEXT.has(value))
      out[key] = value;
    else if (
      key === "location" &&
      typeof value === "string" &&
      /^(?:preload|app-[a-z]+-[a-f0-9]+|index-[a-f0-9]+|diagnostic-[a-z-]+)\.js:\d{1,7}:\d{1,7}$/.test(
        value,
      )
    )
      out[key] = value;
    else if (value === null && NUMBERS.has(key)) out[key] = null;
  }
  return out;
}

/** A per-process random salt prevents exported identifiers exposing their inputs. */
export function diagnosticAlias(value: unknown, salt: string): string {
  const text = `${salt}:${String(value).slice(0, 8192)}`;
  let a = 0xdeadbeef,
    b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 2654435761);
    b = Math.imul(b ^ text.charCodeAt(i), 1597334677);
  }
  return `d-${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}
export function diagnosticError(
  error: unknown,
  salt: string,
): DiagnosticRecord {
  let message = "",
    name = "Error",
    code: unknown,
    stack = "";
  try {
    if (typeof error === "string") message = error.slice(0, 8192);
    else if (error && typeof error === "object") {
      const e = error as {
        message?: unknown;
        name?: unknown;
        code?: unknown;
        jsonRpcCode?: unknown;
        stack?: unknown;
      };
      if (typeof e.message === "string") message = e.message.slice(0, 8192);
      if (typeof e.name === "string") name = e.name;
      code = e.code ?? e.jsonRpcCode;
      if (typeof e.stack === "string") stack = e.stack.slice(0, 8192);
    }
  } catch {
    /* Exotic thrown values must not break the application. */
  }
  const exact = [...TEXT].find(
    (v) => message === v || message.startsWith(`${v} The request `),
  );
  const reason = /queue.*full/i.test(message)
    ? "queue-full"
    : /expired while queued/i.test(message)
      ? "queue-expired"
      : /timeout|timed out|超时/i.test(message)
        ? "timeout"
        : /unauthori[sz]ed|authentication|401\b/i.test(message)
          ? "authentication"
          : /permission|forbidden|403\b/i.test(message)
            ? "permission"
            : /rate.limit|429\b/i.test(message)
              ? "rate-limit"
              : /abort|cancel/i.test(name + message)
                ? "abort"
                : /disconnect|interrupted|connection.*closed|连接中断/i.test(
                      message,
                    )
                  ? "disconnect"
                  : /fetch failed|failed to fetch|network/i.test(message)
                    ? "network"
                    : "unknown-error";
  const location =
    /\b((?:preload|app-[a-z]+-[a-f0-9]+|index-[a-f0-9]+)\.js:\d{1,7}:\d{1,7})\b/.exec(
      stack,
    )?.[1];
  return sanitizeDiagnosticRecord({
    errorName: name,
    reason,
    explicit: !!exact,
    code: typeof code === "number" ? code : undefined,
    errorCode: typeof code === "string" ? code : undefined,
    fingerprint: diagnosticAlias(`${name}:${message}:${location ?? ""}`, salt),
    message:
      exact ??
      (
        {
          authentication: "认证失败",
          permission: "权限不足",
          "rate-limit": "请求过多",
          abort: "请求已取消",
        } as Record<string, string>
      )[reason] ??
      "未分类错误；自由文本已省略",
    location,
  });
}

export class DiagnosticRing {
  private entries: DiagnosticRecord[] = [];
  dropped = 0;
  constructor(
    readonly limit: number,
    readonly ttlMs = Infinity,
  ) {}
  push(value: unknown, now = Date.now()) {
    this.trim(now);
    this.entries.push(sanitizeDiagnosticRecord(value));
    while (this.entries.length > this.limit) {
      this.entries.shift();
      this.dropped++;
    }
  }
  trim(now: number) {
    while (
      this.entries.length &&
      now - Number(this.entries[0]!.at) > this.ttlMs
    ) {
      this.entries.shift();
      this.dropped++;
    }
  }
  snapshot(now = Date.now()) {
    this.trim(now);
    return {
      events: this.entries.map((e) => ({ ...e })),
      dropped: this.dropped,
      firstAt: this.entries[0]?.at ?? null,
      lastAt: this.entries.at(-1)?.at ?? null,
      limit: this.limit,
      truncated: this.dropped > 0,
      supported: true,
    };
  }
  clear() {
    this.entries = [];
    this.dropped = 0;
  }
}

function dropEvents(bucket: any, count: number) {
  if (!bucket?.events?.length || count <= 0) return;
  bucket.events.splice(0, count);
  bucket.dropped = Number(bucket.dropped ?? 0) + count;
  bucket.truncated = true;
  bucket.firstAt = bucket.events[0]?.at ?? null;
  bucket.lastAt = bucket.events.at(-1)?.at ?? null;
}

/** Limits apply to the tab, including archived documents, not once per refresh. */
export function capDiagnosticPages(pages: any[]) {
  const limits = {
    requests: 1000,
    lifecycle: 200,
    errors: 200,
    performance: 200,
    operationSteps: 1600,
  };
  let operations = 50;
  for (const page of [...pages].reverse()) {
    for (const [key, limit] of Object.entries(limits)) {
      const bucket = page[key];
      if (!Array.isArray(bucket?.events)) continue;
      dropEvents(bucket, Math.max(0, bucket.events.length - limit));
      limits[key as keyof typeof limits] -= bucket.events.length;
    }
    const removed = Math.max(0, (page.operations?.length ?? 0) - operations);
    if (removed) {
      page.operations.splice(0, removed);
      const info = ((page.completeness ??= {}).operations ??= {});
      info.dropped = Number(info.dropped ?? 0) + removed;
      info.truncated = true;
    }
    operations -= page.operations?.length ?? 0;
  }
}

/** Shed detail across documents before losing failures, outcomes or milestones. */
export function trimDiagnosticPages(pages: any[]): boolean {
  for (const key of [
    "requests",
    "performance",
    "lifecycle",
    "operationSteps",
  ]) {
    const bucket = pages.find((page) => page[key]?.events?.length)?.[key];
    if (bucket) {
      dropEvents(bucket, Math.max(1, Math.ceil(bucket.events.length / 4)));
      return true;
    }
  }
  // An old document's pending calls are historical evidence, never live blockers.
  const old = pages.slice(0, -1).find((page) => page.pending?.length);
  if (old) {
    const removed = old.pending.splice(
      0,
      Math.max(1, Math.ceil(old.pending.length / 4)),
    );
    const info = ((old.completeness ??= {}).pending ??= {});
    info.dropped = Number(info.dropped ?? 0) + removed.length;
    info.truncated = true;
    return true;
  }
  const current = pages.at(-1);
  if (current?.pending?.length > 100) {
    const removed = Math.min(
      current.pending.length - 100,
      Math.ceil(current.pending.length / 4),
    );
    for (let i = 0; i < removed; i++) {
      const index = current.pending.findIndex(
        (r: any) => !r.required && !r.operationId,
      );
      current.pending.splice(index < 0 ? 0 : index, 1);
    }
    const info = ((current.completeness ??= {}).pending ??= {});
    info.dropped = Number(info.dropped ?? 0) + removed;
    info.truncated = true;
    return true;
  }
  const errors = pages.find((page) => page.errors?.events?.length)?.errors;
  if (errors) {
    dropEvents(errors, Math.max(1, Math.ceil(errors.events.length / 4)));
    return true;
  }
  if (pages.length > 1) {
    pages.shift();
    return true;
  }
  return false;
}
