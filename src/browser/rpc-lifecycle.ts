type RpcMessage = {
  type: "mcp-request" | "thread-prewarm-start";
  hostId: string;
  request: { id: string | number; method: string };
  timeoutMs?: number;
  expiresAtMs?: number;
};

type PendingRpc = {
  invokeId: string;
  message: RpcMessage;
  sent: boolean;
  deadline: number | null;
  timer?: ReturnType<typeof setTimeout>;
};

const CONFIG_READ_TIMEOUT_MS = 15_000;
const STARTUP_READS = new Set([
  "config/read",
  "configRequirements/read",
  "model/list",
  "account/read",
  "thread/list",
  "thread/read",
  "thread/resume",
]);

export function isTransportFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "CodexWebTransportError" ||
      error.name === "AppServerRequestDeliveryError")
  );
}

function rpcMessage(value: unknown): RpcMessage | null {
  const message = value as RpcMessage | null;
  return message &&
    (message.type === "mcp-request" ||
      message.type === "thread-prewarm-start") &&
    typeof message.hostId === "string" &&
    (typeof message.request?.id === "string" ||
      typeof message.request?.id === "number") &&
    typeof message.request.method === "string"
    ? message
    : null;
}

/** IPC acknowledgement and app-server completion are separate lifetimes. */
export class RpcLifecycle {
  private pending = new Map<string, PendingRpc>();
  private byRequest = new Map<string, string>();

  constructor(
    private readonly emit: (event: unknown) => void,
    private readonly settleInvoke: (id: string, error?: Error) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.pending.size;
  }

  track(invokeId: string, channel: string, args: unknown[]): boolean {
    if (channel !== "codex_desktop:message-from-view") return false;
    const message = rpcMessage(args[0]);
    if (!message) return false;
    const bounded = STARTUP_READS.has(message.request.method);
    const timeout =
      typeof message.timeoutMs === "number" && message.timeoutMs > 0
        ? Math.min(message.timeoutMs, CONFIG_READ_TIMEOUT_MS)
        : CONFIG_READ_TIMEOUT_MS;
    const deadline = bounded
      ? Math.min(
          this.now() + timeout,
          typeof message.expiresAtMs === "number"
            ? message.expiresAtMs
            : Infinity,
        )
      : null;
    const pending: PendingRpc = { invokeId, message, sent: false, deadline };
    this.pending.set(invokeId, pending);
    this.byRequest.set(this.key(message.hostId, message.request.id), invokeId);
    if (deadline !== null) {
      pending.timer = setTimeout(
        () => this.expire(),
        Math.max(0, deadline - this.now()),
      );
    }
    return true;
  }

  sent(invokeId: string): void {
    const request = this.pending.get(invokeId);
    if (request) request.sent = true;
  }

  /** Called by the native client, including chunked replies and native timeouts. */
  onLifecycle(event: {
    type: string;
    hostId: string;
    id?: string | number;
  }): void {
    if (
      event.id === undefined ||
      !["completed", "failed", "timed-out"].includes(event.type)
    )
      return;
    const id = this.byRequest.get(this.key(event.hostId, event.id));
    if (id !== undefined && this.take(id)) this.settleInvoke(id);
  }

  fail(invokeId: string, reason: string): boolean {
    const pending = this.take(invokeId);
    if (!pending) return false;
    const message = `${reason}${pending.sent ? " The request may have reached the server; check the conversation before retrying." : " The request was not sent."}`;
    const error = new Error(message);
    error.name = "CodexWebTransportError";
    this.settleInvoke(invokeId, error);
    // Native onDelivery(failed) rejects the real RPC, releases capacity and
    // unwinds the composer's finally. outcome-unknown alone does not reject it.
    this.emit({
      type: "mcp-request-delivery",
      hostId: pending.message.hostId,
      update: {
        type: "failed",
        delivery: {
          requestId: pending.message.request.id,
          method: pending.message.request.method,
          stage: pending.sent ? "outcome-unknown" : "not-sent",
        },
        message,
      },
    });
    return true;
  }

  disconnect(): void {
    // Snapshot: rejecting native requests may synchronously pump its queue.
    for (const id of [...this.pending.keys()]) {
      this.fail(id, "Connection interrupted.");
    }
  }

  expire(): void {
    for (const [id, pending] of [...this.pending]) {
      if (pending.deadline !== null && pending.deadline <= this.now()) {
        this.fail(
          id,
          "Configuration read timed out. Your draft has been kept.",
        );
      }
    }
  }

  private key(hostId: string, id: string | number): string {
    return JSON.stringify([hostId, String(id)]);
  }

  private take(id: string): PendingRpc | undefined {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.byRequest.delete(
      this.key(pending.message.hostId, pending.message.request.id),
    );
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    return pending;
  }
}
