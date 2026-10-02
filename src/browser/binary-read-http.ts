const ENDPOINT = "/__backend/binary-read";
const MAX_BYTES = 32 * 1024 * 1024;
type ReadEvent = Record<string, unknown> & { requestId: string };

export function isBinaryRead(event: unknown): event is ReadEvent {
  const value = event as ReadEvent | null;
  return (
    value?.type === "fetch" &&
    value.url === "vscode://codex/read-file-binary" &&
    typeof value.requestId === "string"
  );
}

/** Diagnostic payloads must never congest the command/heartbeat connection. */
export function isOversizedDiagnosticLog(event: unknown): boolean {
  if ((event as { type?: string } | null)?.type !== "log-message") return false;
  const json = JSON.stringify(event);
  return (
    json.length > 16 * 1024 || new TextEncoder().encode(json).length > 16 * 1024
  );
}

export class BinaryReadHttpClient {
  private closed = false;
  private ready: Promise<boolean>;
  private resolveReady!: (open: boolean) => void;
  private timer: ReturnType<typeof setTimeout>;
  private pending = new Map<string, AbortController>();

  constructor(
    private readonly clientId: string,
    private readonly emit: (event: Record<string, unknown>) => void,
    private readonly request: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.timer = setTimeout(() => this.close(), 15_000);
  }

  open(): void {
    clearTimeout(this.timer);
    this.resolveReady(!this.closed);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.resolveReady(false);
    for (const controller of this.pending.values()) controller.abort();
  }

  cancel(requestId: string): boolean {
    const controller = this.pending.get(requestId);
    controller?.abort();
    return !!controller;
  }

  async read(event: ReadEvent): Promise<void> {
    const fail = (error: string) =>
      this.emit({
        type: "fetch-response",
        responseType: "error",
        requestId: event.requestId,
        status: 432,
        error,
      });
    if (
      this.closed ||
      this.pending.size >= 8 ||
      this.pending.has(event.requestId)
    ) {
      fail("File read connection unavailable");
      return;
    }
    const controller = new AbortController();
    this.pending.set(event.requestId, controller);
    try {
      if (!(await this.ready)) throw new Error("File read connection closed");
      controller.signal.throwIfAborted();
      const response = await this.request(
        `${ENDPOINT}?clientId=${this.clientId}`,
        {
          method: "POST",
          credentials: "same-origin",
          mode: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(65_000),
          ]),
        },
      );
      if (!response.ok)
        throw new Error(`File read failed (${response.status})`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("File read response missing");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) {
            await reader.cancel();
            throw new Error("File read exceeds size limit");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const result = JSON.parse(await new Blob(chunks).text());
      if (
        result?.type !== "fetch-response" ||
        result.requestId !== event.requestId ||
        !["success", "error"].includes(result.responseType)
      )
        throw new Error("Invalid file read response");
      if (this.closed || controller.signal.aborted)
        throw new Error("File read cancelled");
      this.emit(result);
    } catch (error) {
      // Settle the native fetch even on HTTP errors; never retry a closed read.
      fail(error instanceof Error ? error.message : "File read failed");
    } finally {
      this.pending.delete(event.requestId);
    }
  }
}
