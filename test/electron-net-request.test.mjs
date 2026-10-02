import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";

const require = createRequire(import.meta.url);
const { net } = require("../src/server/electron/index.js");
const source = await readFile(
  "scratch/asar/.vite/build/main-C3nRcJ3D.js",
  "utf8",
);
const start = source.indexOf("function YKe(");
const end = source.indexOf("var XKe =", start);
assert.ok(start > 0 && end > start, "pinned Desktop preview implementation");
const preview = new Function("g", `${source.slice(start, end)}; return YKe;`)({
  net,
});

async function server(t, handler) {
  const app = createServer(handler);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => {
    app.closeAllConnections();
    app.close();
  });
  return `http://127.0.0.1:${app.address().port}`;
}

test("real Desktop website preview receives response bytes and manual redirects", async (t) => {
  let redirected = false;
  const base = await server(t, (req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/destination" });
      res.end();
    } else {
      if (req.url === "/destination") redirected = true;
      res.setHeader("content-type", "text/plain");
      res.write("preview ");
      res.end("content");
    }
  });
  const response = await preview(base, {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "preview content");
  const redirect = await preview(`${base}/redirect`, {});
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), `${base}/destination`);
  assert.equal(redirected, false);
});

test("canceling the real Desktop website preview aborts its request without an uncaught server error", async (t) => {
  let incoming;
  const seen = new Promise((resolve) => {
    incoming = resolve;
  });
  const base = await server(t, (req) => incoming(req));
  const controller = new AbortController();
  const result = preview(base, { signal: controller.signal });
  const rejected = assert.rejects(result, { name: "AbortError" });
  const req = await seen;
  req.on("error", () => {}); // The server sees the expected canceled HTTP request.
  const closed = new Promise((resolve) => req.once("close", resolve));
  controller.abort();
  controller.abort();
  await rejected;
  await closed;
});

test("native request supports streamed writes and preserves headers", async (t) => {
  let body;
  const base = await server(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks).toString();
    assert.equal(req.headers["x-request-test"], "header");
    res.end("ok");
  });
  const url = new URL(base);
  const request = net.request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: Number(url.port),
    path: "/events?test=1",
    method: "POST",
  });
  request.setHeader("X-Request-Test", "header");
  assert.equal(request.getHeader("x-request-test"), "header");
  const pending = once(request, "response");
  Readable.from(["first ", "second"]).pipe(request);
  const [response] = await pending;
  for await (const _chunk of response) {
  }
  assert.equal(body, "first second");
});
