import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const compress = promisify(gzip);
const ENDPOINT = "/__backend/binary-read";
const PREFIX = "codex-web-binary:";
const MAX_BYTES = 32 * 1024 * 1024;
type Event = Record<string, unknown>;
type Pending = {
  client: object;
  finish: (event: Event, cancel?: boolean) => void;
};

/** Keep native local/SSH reads and permission checks, but carry bytes over HTTP. */
export class BinaryReadHttp {
  private clients = new Map<string, object>();
  private pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs = 60_000) {}

  connect(clientId: string): void {
    this.clients.set(clientId, {});
  }

  disconnect(clientId: string): void {
    const client = this.clients.get(clientId);
    this.clients.delete(clientId);
    for (const task of this.pending.values()) {
      if (task.client === client)
        task.finish(this.failure("File read connection closed"), true);
    }
  }

  capture(message: unknown): boolean {
    const envelope = message as {
      type?: string;
      channel?: string;
      args?: Event[];
    };
    const event = envelope?.args?.[0];
    if (
      envelope?.type !== "ipc-main-event" ||
      envelope.channel !== "codex_desktop:message-for-view" ||
      event?.type !== "fetch-response" ||
      typeof event.requestId !== "string" ||
      !event.requestId.startsWith(PREFIX)
    )
      return false;
    // IDs belong only to this transport. Late/cancelled results must not leak
    // into other tabs or return to the control WebSocket.
    this.pending.get(event.requestId)?.finish(event);
    return true;
  }

  private failure(error: string): Event {
    return {
      type: "fetch-response",
      responseType: "error",
      status: 432,
      error,
    };
  }

  async install(
    app: FastifyInstance,
    invoke: (event: Event) => unknown,
  ): Promise<void> {
    await app.register(async (route) => {
      let active = 0;
      const releases = new WeakMap<object, () => void>();
      route.addHook("onRequest", async (req, reply) => {
        reply.header("Cache-Control", "no-store");
        if (active >= 8)
          return reply
            .code(503)
            .header("Retry-After", "1")
            .send({ error: "busy" });
        active++;
        const release = () => {
          if (!releases.delete(req)) return;
          active--;
          req.raw.off("aborted", release);
          reply.raw.off("close", release);
        };
        releases.set(req, release);
        req.raw.once("aborted", release);
        reply.raw.once("close", release);
      });
      route.addHook("onResponse", async (req) => releases.get(req)?.());
      route.post<{ Querystring: { clientId?: string }; Body: Event }>(
        ENDPOINT,
        { bodyLimit: 64 * 1024 },
        async (req, reply) => {
          const clientId = req.query.clientId ?? "";
          const client = this.clients.get(clientId);
          if (!client)
            return reply.code(409).send({ error: "connection closed" });
          const event = req.body;
          if (
            event?.type !== "fetch" ||
            event.url !== "vscode://codex/read-file-binary" ||
            typeof event.requestId !== "string" ||
            !/^[0-9a-f-]{36}$/i.test(event.requestId)
          )
            return reply.code(400).send({ error: "invalid binary read" });
          const requestId = PREFIX + randomUUID();
          let cancel!: () => void;
          const result = new Promise<Event>((resolve) => {
            let done = false;
            const finish = (response: Event, abort = false) => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              this.pending.delete(requestId);
              if (abort) {
                void Promise.resolve()
                  .then(() => invoke({ type: "cancel-fetch", requestId }))
                  .catch(() => {});
              }
              resolve({ ...response, requestId: event.requestId });
            };
            const timer = setTimeout(
              () => finish(this.failure("File read timed out"), true),
              this.timeoutMs,
            );
            cancel = () => finish(this.failure("File read cancelled"), true);
            this.pending.set(requestId, { client, finish });
            req.raw.once("aborted", cancel);
            reply.raw.once("close", cancel);
            // Register before dispatch: native handlers may reply synchronously.
            void Promise.resolve()
              .then(() => {
                if (!done) return invoke({ ...event, requestId });
              })
              .catch(() =>
                finish(this.failure("Native file read failed"), true),
              );
          });
          try {
            const response = await result;
            if (reply.raw.destroyed) return;
            if (this.clients.get(clientId) !== client)
              return reply.code(409).send({ error: "connection closed" });
            const body = Buffer.from(JSON.stringify(response));
            if (body.length > MAX_BYTES)
              return reply
                .code(413)
                .send({ error: "file read exceeds size limit" });
            reply.type("application/json").header("Vary", "Accept-Encoding");
            if (
              (req.headers["accept-encoding"] ?? "").split(",").some((part) => {
                const [coding, ...params] = part.trim().split(";");
                return (
                  coding === "gzip" &&
                  !params.some((p) => /^\s*q=0(?:\.0*)?\s*$/.test(p))
                );
              })
            )
              return reply
                .header("Content-Encoding", "gzip")
                .send(await compress(body));
            return reply.send(body);
          } finally {
            req.raw.off("aborted", cancel);
            reply.raw.off("close", cancel);
          }
        },
      );
    });
  }
}
