import type { FastifyInstance } from "fastify";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const compress = promisify(gzip);
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SDK_QUERY_KEYS = new Set(["ec", "k", "st", "sv", "t", "sid", "se", "gz"]);

async function readBoundedResponse(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, bytes);
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("feature configuration response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function acceptsGzip(header: string | undefined): boolean {
  return (header ?? "").split(",").some((part) => {
    const [coding, ...parameters] = part.trim().split(";");
    return (
      coding === "gzip" &&
      !parameters.some((value) => /^\s*q=0(?:\.0*)?\s*$/.test(value))
    );
  });
}

/** Registered under the existing Web authentication hook; never an arbitrary proxy. */
export async function installFeatureConfigRoute(
  app: FastifyInstance,
  { request = globalThis.fetch, timeoutMs = 15_000 } = {},
): Promise<void> {
  await app.register(async (route) => {
    let active = 0;
    route.removeAllContentTypeParsers();
    route.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body),
    );
    route.addHook("onRequest", async (_req, reply) => {
      reply.header("Cache-Control", "no-store");
    });
    route.post<{ Body: Buffer }>(
      "/__backend/feature-config",
      { bodyLimit: MAX_REQUEST_BYTES },
      async (req, reply) => {
        if (active >= 4) {
          return reply
            .code(503)
            .header("Retry-After", "1")
            .send({ error: "busy" });
        }
        active++;
        const client = new AbortController();
        const timeout = AbortSignal.timeout(timeoutMs);
        const abort = () => client.abort();
        req.raw.once("aborted", abort);
        reply.raw.once("close", abort);
        try {
          const incoming = new URL(req.raw.url ?? req.url, "http://localhost");
          const upstream = new URL("https://ab.chatgpt.com/v1/initialize");
          for (const [key, value] of incoming.searchParams) {
            if (SDK_QUERY_KEYS.has(key))
              upstream.searchParams.append(key, value);
          }
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (
              typeof value === "string" &&
              (key === "content-type" ||
                key === "content-encoding" ||
                /^statsig-[a-z0-9-]+$/.test(key))
            ) {
              headers.set(key, value);
            }
          }
          const response = await request(upstream, {
            method: "POST",
            headers,
            body: new Uint8Array(req.body),
            redirect: "error",
            signal: AbortSignal.any([client.signal, timeout]),
          });
          const body = await readBoundedResponse(response);
          reply.code(response.status).header("Vary", "Accept-Encoding");
          for (const key of ["content-type", "retry-after"]) {
            const value = response.headers.get(key);
            if (value) reply.header(key, value);
          }
          if (
            body.length > 1024 &&
            acceptsGzip(req.headers["accept-encoding"])
          ) {
            const compressed = await compress(body);
            reply.header("Content-Encoding", "gzip");
            return reply.send(compressed);
          }
          return reply.send(body);
        } catch {
          return reply.code(timeout.aborted ? 504 : 502).send({
            error: "feature configuration request failed",
          });
        } finally {
          active--;
          req.raw.off("aborted", abort);
          reply.raw.off("close", abort);
        }
      },
    );
  });
}
