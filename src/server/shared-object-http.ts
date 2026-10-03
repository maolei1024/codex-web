import type { FastifyInstance } from "fastify";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const MAX_BYTES = 8 * 1024 * 1024;
const ENDPOINT = "/__backend/shared-object/statsig-evaluations";
const REVISION_HEADER = "x-codex-shared-revision";

/** Bulk data stays separate from the ordered startup/command WebSocket. */
export class SharedObjectHttp {
  private clients = new Map<string, () => boolean>();
  private revision = 0;
  private snapshot?: { revision: number; body: Buffer; gzip?: Promise<Buffer> };

  connect(clientId: string, subscribed: () => boolean): boolean {
    if (this.clients.has(clientId)) return false;
    this.clients.set(clientId, subscribed);
    return true;
  }

  disconnect(clientId: string): void {
    this.clients.delete(clientId);
  }

  capture(message: unknown): number {
    const body = Buffer.from(JSON.stringify(message));
    // The native repository can publish the same snapshot to each scoped renderer.
    // Reuse its revision so one tab's notification cannot invalidate another's read.
    if (this.snapshot?.body.equals(body)) return this.snapshot.revision;
    const revision = ++this.revision;
    // Invalidate the previous identity even if a future Desktop exceeds bounds.
    this.snapshot = body.length <= MAX_BYTES ? { revision, body } : undefined;
    return revision;
  }

  async install(
    app: FastifyInstance,
    invoke: (event: unknown, clientId: string) => unknown,
  ): Promise<void> {
    await app.register(async (route) => {
      let active = 0;
      route.removeAllContentTypeParsers();
      route.addContentTypeParser(
        "*",
        { parseAs: "buffer" },
        (_req, body, done) => done(null, body),
      );
      const releases = new WeakMap<object, () => void>();
      route.addHook("onRequest", async (req, reply) => {
        reply.header("Cache-Control", "no-store");
        if (active >= 4)
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

      route.get<{ Querystring: { clientId?: string; revision?: string } }>(
        ENDPOINT,
        async (req, reply) => {
          const subscribed = this.clients.get(req.query.clientId ?? "");
          if (!subscribed?.())
            return reply.code(409).send({ error: "subscription closed" });
          reply.header(REVISION_HEADER, String(this.revision));
          if (req.query.revision !== String(this.revision))
            return reply.code(409).send({ error: "snapshot changed" });
          const snapshot = this.snapshot;
          if (!snapshot)
            return reply.code(413).send({ error: "snapshot unavailable" });
          reply.type("application/json").header("Vary", "Accept-Encoding");
          if (
            (req.headers["accept-encoding"] ?? "").split(",").some((part) => {
              const [coding, ...params] = part.trim().split(";");
              return (
                coding === "gzip" &&
                !params.some((p) => /^\s*q=0(?:\.0*)?\s*$/.test(p))
              );
            })
          ) {
            const body = await (snapshot.gzip ??= compress(snapshot.body));
            if (
              !subscribed() ||
              this.clients.get(req.query.clientId ?? "") !== subscribed
            )
              return reply.code(409).send({ error: "subscription closed" });
            return reply.header("Content-Encoding", "gzip").send(body);
          }
          return reply.send(snapshot.body);
        },
      );

      route.post<{ Querystring: { clientId?: string }; Body: Buffer }>(
        ENDPOINT,
        { bodyLimit: MAX_BYTES },
        async (req, reply) => {
          const client = this.clients.get(req.query.clientId ?? "");
          if (!client)
            return reply.code(409).send({ error: "connection closed" });
          let event;
          try {
            const encoding = req.headers["content-encoding"];
            if (encoding && encoding !== "gzip" && encoding !== "identity")
              return reply.code(415).send({ error: "unsupported encoding" });
            const body =
              encoding === "gzip"
                ? await decompress(req.body, { maxOutputLength: MAX_BYTES })
                : req.body;
            event = JSON.parse(body.toString("utf8"));
            if (
              event?.type !== "shared-object-set" ||
              event.key !== "statsig_evaluations" ||
              !Object.hasOwn(event, "value")
            )
              return reply.code(400).send({ error: "invalid shared object" });
          } catch (error) {
            return reply
              .code(
                (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE"
                  ? 413
                  : 400,
              )
              .send({ error: "invalid shared object" });
          }
          // An upload belonging to a closed socket must never overwrite a new session.
          if (this.clients.get(req.query.clientId ?? "") !== client)
            return reply.code(409).send({ error: "connection closed" });
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              // Capture the live renderer synchronously after the identity check;
              // a reused clientId must never redirect this write to a new socket.
              Promise.resolve(invoke(event, req.query.clientId!)),
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("timeout")), 15_000);
              }),
            ]);
            return reply.send({ result });
          } catch {
            return reply
              .code(502)
              .send({ error: "shared object publication failed" });
          } finally {
            clearTimeout(timer);
          }
        },
      );
    });
  }
}
