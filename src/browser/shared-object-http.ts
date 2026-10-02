const ENDPOINT = "/__backend/shared-object/statsig-evaluations";
const MAX_BYTES = 8 * 1024 * 1024;

type SnapshotMessage = {
  type: "ipc-main-event";
  channel: string;
  args: unknown[];
};

/** One instance per socket: no bulk write is replayed across connections. */
export class SharedObjectHttpClient {
  readonly clientId = crypto.randomUUID();
  private closed = new AbortController();
  private ready: Promise<boolean>;
  private resolveReady!: (ready: boolean) => void;
  private readyTimer: ReturnType<typeof setTimeout>;
  private latest = 0;
  private applied = 0;
  private reading = false;
  private writes = 0;
  private publicationVersion = 0;
  private publication: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly emit: (message: SnapshotMessage) => void,
    private readonly report: (error: unknown) => void,
    private readonly request: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.readyTimer = setTimeout(() => this.close(), 15_000);
  }

  open(): void {
    clearTimeout(this.readyTimer);
    this.resolveReady(!this.closed.signal.aborted);
  }

  close(): void {
    clearTimeout(this.readyTimer);
    this.closed.abort();
    this.resolveReady(false);
  }

  changed(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision <= 0) return;
    this.latest = Math.max(this.latest, revision);
    this.read();
  }

  publish(event: unknown): Promise<unknown> {
    if (this.writes >= 4)
      return Promise.reject(new Error("shared object publication busy"));
    this.writes++;
    this.publicationVersion++;
    const task = this.publication
      .then(async () => {
        if (!(await this.ready))
          throw new Error("shared object connection closed");
        this.closed.signal.throwIfAborted();
        const raw = new Blob([JSON.stringify(event)], {
          type: "application/json",
        });
        if (raw.size > MAX_BYTES)
          throw new Error("shared object exceeds size limit");
        const compressed = typeof CompressionStream !== "undefined";
        const body = compressed
          ? await new Response(
              raw.stream().pipeThrough(new CompressionStream("gzip")),
            ).blob()
          : raw;
        const response = await this.request(
          `${ENDPOINT}?clientId=${this.clientId}`,
          {
            ...this.options(),
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(compressed ? { "Content-Encoding": "gzip" } : {}),
            },
            body,
          },
        );
        if (!response.ok)
          throw new Error(
            `shared object publication failed (${response.status})`,
          );
        return (await response.json()).result;
      })
      .finally(() => {
        this.writes--;
        this.read();
      });
    this.publication = task.catch(() => {});
    return task;
  }

  private options(): RequestInit {
    return {
      credentials: "same-origin",
      mode: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([
        this.closed.signal,
        AbortSignal.timeout(60_000),
      ]),
    };
  }

  private read(): void {
    if (
      this.reading ||
      this.writes ||
      this.closed.signal.aborted ||
      this.latest <= this.applied
    )
      return;
    this.reading = true;
    void (async () => {
      let failures = 0;
      while (
        !this.closed.signal.aborted &&
        !this.writes &&
        this.latest > this.applied
      ) {
        const revision = this.latest;
        const publicationVersion = this.publicationVersion;
        try {
          const response = await this.request(
            `${ENDPOINT}?clientId=${this.clientId}&revision=${revision}`,
            this.options(),
          );
          const receivedRevision = Number(
            response.headers.get("x-codex-shared-revision"),
          );
          if (response.status === 409 && receivedRevision > revision) {
            this.latest = Math.max(this.latest, receivedRevision);
            continue;
          }
          if (!response.ok)
            throw new Error(`shared object read failed (${response.status})`);
          const reader = response.body?.getReader();
          if (!reader) throw new Error("shared object response missing");
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > MAX_BYTES) {
                await reader.cancel();
                throw new Error("shared object exceeds size limit");
              }
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
          const message = JSON.parse(await new Blob(chunks).text());
          if (
            message?.type !== "ipc-main-event" ||
            message.channel !== "codex_desktop:message-for-view" ||
            message.args?.[0]?.type !== "shared-object-updated" ||
            message.args[0].key !== "statsig_evaluations" ||
            receivedRevision !== revision
          )
            throw new Error("invalid shared object snapshot");
          if (
            !this.closed.signal.aborted &&
            !this.writes &&
            this.latest === revision &&
            publicationVersion === this.publicationVersion
          ) {
            this.applied = revision;
            this.emit(message);
          }
          failures = 0;
        } catch (error) {
          if (this.closed.signal.aborted) return;
          if (++failures >= 3) {
            this.report(error);
            return;
          }
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              this.closed.signal.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(finish, failures * 1_000);
            this.closed.signal.addEventListener("abort", finish, {
              once: true,
            });
          });
        }
      }
    })().finally(() => {
      this.reading = false;
    });
  }
}
