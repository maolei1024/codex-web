import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import Fastify from "fastify";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { BinaryReadHttp } = await importTypescriptModule(
  "src/server/binary-read-http.ts",
);
const { BinaryReadHttpClient, isBinaryRead, isOversizedDiagnosticLog } =
  await importTypescriptModule("src/browser/binary-read-http.ts");
const { installAuthHook } = await importTypescriptModule("src/server/auth.ts");
const endpoint = "/__backend/binary-read?clientId=tab";
const headers = { cookie: "codex_web_token=test-secret" };
const read = () => ({
  type: "fetch",
  requestId: randomUUID(),
  url: "vscode://codex/read-file-binary",
  body: '{"path":"/workspace/image.png","hostId":"remote"}',
});
const response = (requestId, body = "image-base64") => ({
  type: "fetch-response",
  requestId,
  responseType: "success",
  status: 200,
  headers: { "content-type": "application/json" },
  bodyJsonString: JSON.stringify({ data: body }),
});
const envelope = (event) => ({
  type: "ipc-main-event",
  channel: "codex_desktop:message-for-view",
  args: [event],
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(test) {
  for (let i = 0; i < 200; i++) {
    if (test()) return;
    await tick();
  }
  assert.fail("condition not reached");
}
async function server(t, native, timeout, owner) {
  const app = Fastify(),
    transport = new BinaryReadHttp(timeout),
    calls = [],
    invocations = [];
  installAuthHook(app, "test-secret");
  await transport.install(app, (event, clientId, requestOwner) => {
    calls.push(event);
    invocations.push({ event, clientId, owner: requestOwner });
    return native?.(event, transport, clientId, requestOwner);
  });
  transport.connect("tab", owner);
  t.after(() => {
    transport.disconnect("tab");
    return app.close();
  });
  const post = (payload = read(), opts = {}) =>
    app.inject({ method: "POST", url: endpoint, payload, headers, ...opts });
  return { app, transport, calls, invocations, post };
}

test("binary reads preserve native SSH request/result and use authenticated gzip HTTP, without capturing ordinary fetches", async (t) => {
  const data = "image".repeat(300000);
  const { calls, transport, post } = await server(t, (event, bridge) =>
    bridge.capture(envelope(response(event.requestId, data))),
  );
  const event = read();
  assert.equal((await post(event, { headers: {} })).statusCode, 401);
  assert.equal(calls.length, 0);
  const result = await post(event, {
    headers: { ...headers, "accept-encoding": "gzip" },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["content-encoding"], "gzip");
  assert.deepEqual(
    JSON.parse(gunzipSync(result.rawPayload)),
    response(event.requestId, data),
  );
  assert.deepEqual({ ...calls[0], requestId: event.requestId }, event);
  assert.notEqual(calls[0].requestId, event.requestId);
  assert.equal(transport.capture(envelope(response(event.requestId))), false);
  assert.equal(
    transport.capture(envelope(response(calls[0].requestId))),
    true,
    "late bulk replies stay off WebSocket",
  );
});

test("binary HTTP forwards native permission errors and bounds URLs, input and output", async (t) => {
  let nativeError = true;
  const { post, transport, calls } = await server(t, (event, bridge) =>
    bridge.capture(
      envelope(
        nativeError
          ? {
              type: "fetch-response",
              requestId: event.requestId,
              responseType: "error",
              status: 403,
              error: "Native permission denied",
            }
          : response(event.requestId, "x".repeat(32 * 1024 * 1024)),
      ),
    ),
  );
  const event = read();
  assert.deepEqual((await post(event)).json(), {
    type: "fetch-response",
    requestId: event.requestId,
    responseType: "error",
    status: 403,
    error: "Native permission denied",
  });
  assert.equal(
    (await post({ ...event, url: "vscode://codex/write-file" })).statusCode,
    400,
  );
  assert.equal(
    (await post({ ...event, body: "x".repeat(65536) })).statusCode,
    413,
  );
  nativeError = false;
  assert.equal((await post()).statusCode, 413);
  transport.disconnect("tab");
  assert.equal((await post()).statusCode, 409);
  assert.equal(calls.length, 2);
});

test("timeouts and disconnects cancel exact native IDs, isolate tabs, and suppress late responses", async (t) => {
  const ownerA = {},
    ownerB = {};
  const { post, calls, invocations, transport } = await server(
    t,
    null,
    40,
    ownerA,
  );
  transport.connect("other-tab", ownerB);
  t.after(() => transport.disconnect("other-tab"));
  const first = post().then((r) => r.json());
  const second = post(read(), {
    url: endpoint.replace("tab", "other-tab"),
  }).then((r) => r.json());
  await until(() => calls.length === 2);
  const [a, b] = calls;
  transport.disconnect("tab");
  assert.match((await first).error, /connection closed/);
  await until(() => calls.some((e) => e.type === "cancel-fetch"));
  assert.ok(
    calls.some((e) => e.type === "cancel-fetch" && e.requestId === a.requestId),
  );
  assert.ok(
    !calls.some(
      (e) => e.type === "cancel-fetch" && e.requestId === b.requestId,
    ),
  );
  assert.match((await second).error, /timed out/);
  await tick();
  assert.ok(
    calls.some((e) => e.type === "cancel-fetch" && e.requestId === b.requestId),
  );
  for (const [event, owner, clientId] of [
    [a, ownerA, "tab"],
    [b, ownerB, "other-tab"],
  ]) {
    const cancelled = invocations.find(
      (call) =>
        call.event.type === "cancel-fetch" &&
        call.event.requestId === event.requestId,
    );
    assert.equal(cancelled.owner, owner);
    assert.equal(cancelled.clientId, clientId);
  }
  assert.equal(transport.capture(envelope(response(a.requestId))), true);
});

test("binary response IDs require their connection owner and reserved late IDs never return to WebSocket", async (t) => {
  const ownerA = {},
    ownerB = {};
  const { post, transport, invocations } = await server(
    t,
    null,
    undefined,
    ownerA,
  );
  transport.connect("other-tab", ownerB);
  t.after(() => transport.disconnect("other-tab"));
  const event = read();
  let settledA = false,
    settledB = false;
  const first = post(event).then((result) => {
    settledA = true;
    return result;
  });
  const second = post(event, {
    url: endpoint.replace("tab", "other-tab"),
  }).then((result) => {
    settledB = true;
    return result;
  });
  await until(() => invocations.length === 2);
  const a = invocations.find((call) => call.clientId === "tab"),
    b = invocations.find((call) => call.clientId === "other-tab");
  assert.equal(a.owner, ownerA);
  assert.equal(b.owner, ownerB);
  assert.notEqual(a.event.requestId, b.event.requestId);
  assert.equal(
    transport.capture(envelope(response(a.event.requestId)), ownerB),
    true,
  );
  assert.equal(transport.capture(envelope(response(a.event.requestId))), true);
  assert.equal(
    transport.capture(envelope(response(b.event.requestId)), ownerA),
    true,
  );
  assert.equal(
    transport.capture(
      envelope(response(`codex-web-binary:${randomUUID()}`)),
      ownerA,
    ),
    true,
  );
  assert.equal(
    transport.capture(envelope(response(event.requestId)), ownerA),
    false,
  );
  await tick();
  assert.equal(settledA, false);
  assert.equal(settledB, false);

  transport.capture(envelope(response(b.event.requestId, "b")), ownerB);
  assert.deepEqual((await second).json(), response(event.requestId, "b"));
  assert.equal(settledA, false);
  transport.capture(envelope(response(a.event.requestId, "a")), ownerA);
  assert.deepEqual((await first).json(), response(event.requestId, "a"));
  assert.equal(
    transport.capture(envelope(response(a.event.requestId)), ownerB),
    true,
  );
});

test("disconnect cancels synchronously using the retired owner and cannot settle a replacement with the same client ID", async (t) => {
  const retired = {},
    replacement = {},
    peer = {};
  const { post, transport, invocations } = await server(
    t,
    null,
    undefined,
    retired,
  );
  transport.connect("other-tab", peer);
  t.after(() => transport.disconnect("other-tab"));
  const event = read(),
    old = post(event),
    other = post(read(), { url: endpoint.replace("tab", "other-tab") });
  await until(() => invocations.length === 2);
  const oldRead = invocations.find((call) => call.clientId === "tab"),
    peerRead = invocations.find((call) => call.clientId === "other-tab");
  transport.disconnect("tab");
  const cancel = invocations.find((call) => call.event.type === "cancel-fetch");
  assert.ok(
    cancel,
    "native cancellation must start before connection teardown finishes",
  );
  assert.equal(cancel.clientId, "tab");
  assert.equal(cancel.owner, retired);
  assert.equal(cancel.event.requestId, oldRead.event.requestId);
  transport.connect("tab", replacement);
  assert.equal((await old).statusCode, 409);
  let settled = false;
  const current = post(event).then((result) => {
    settled = true;
    return result;
  });
  await until(() => invocations.some((call) => call.owner === replacement));
  const currentRead = invocations.find((call) => call.owner === replacement);
  assert.notEqual(currentRead.event.requestId, oldRead.event.requestId);
  assert.equal(
    transport.capture(envelope(response(oldRead.event.requestId)), retired),
    true,
  );
  assert.equal(
    transport.capture(envelope(response(oldRead.event.requestId)), replacement),
    true,
  );
  assert.equal(
    transport.capture(envelope(response(currentRead.event.requestId)), retired),
    true,
  );
  await tick();
  assert.equal(settled, false);
  assert.equal(
    invocations.filter((call) => call.event.type === "cancel-fetch").length,
    1,
  );
  transport.capture(
    envelope(response(currentRead.event.requestId, "new-owner")),
    replacement,
  );
  transport.capture(envelope(response(peerRead.event.requestId, "peer")), peer);
  assert.deepEqual(
    (await current).json(),
    response(event.requestId, "new-owner"),
  );
  assert.equal((await other).statusCode, 200);
});

test("concurrency limit releases capacity after native completion", async (t) => {
  const { post, calls, transport } = await server(t);
  const requests = Array.from({ length: 8 }, () =>
    post().then((r) => r.statusCode),
  );
  await until(() => calls.length === 8);
  assert.equal((await post()).statusCode, 503);
  calls
    .slice()
    .forEach((e) => transport.capture(envelope(response(e.requestId))));
  assert.deepEqual(await Promise.all(requests), Array(8).fill(200));
  const next = post().then((r) => r.statusCode);
  await until(() => calls.length === 9);
  transport.capture(envelope(response(calls[8].requestId)));
  assert.equal(await next, 200);
});

test("HTTP client waits for socket, preserves results, and settles network failures", async (t) => {
  const seen = [],
    events = [];
  const client = new BinaryReadHttpClient(
    "tab",
    (e) => events.push(e),
    async (url, init) => {
      seen.push({ url, init });
      return seen.length === 1
        ? new Response(
            JSON.stringify(response(JSON.parse(init.body).requestId)),
          )
        : new Response("{}", { status: 503 });
    },
  );
  t.after(() => client.close());
  const event = read(),
    first = client.read(event);
  await tick();
  assert.equal(seen.length, 0);
  client.open();
  await first;
  assert.deepEqual(events, [response(event.requestId)]);
  assert.deepEqual(JSON.parse(seen[0].init.body), event);
  assert.equal(seen[0].init.credentials, "same-origin");
  assert.equal(seen[0].init.cache, "no-store");
  await client.read(read());
  assert.match(events[1].error, /503/);
});

test("cancel/disconnect abort HTTP and reject late successes without replay", async () => {
  const pending = [],
    events = [];
  const client = new BinaryReadHttpClient(
    "tab",
    (e) => events.push(e),
    (url, init) => new Promise((resolve) => pending.push({ init, resolve })),
  );
  client.open();
  const a = read(),
    first = client.read(a);
  await until(() => pending.length === 1);
  assert.equal(client.cancel(a.requestId), true);
  assert.equal(pending[0].init.signal.aborted, true);
  pending[0].resolve(new Response(JSON.stringify(response(a.requestId))));
  await first;
  const b = read(),
    second = client.read(b);
  await until(() => pending.length === 2);
  client.close();
  assert.equal(pending[1].init.signal.aborted, true);
  pending[1].resolve(new Response(JSON.stringify(response(b.requestId))));
  await second;
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.responseType === "error"));
  assert.equal(pending.length, 2);
});

test("only binary reads and oversized diagnostic logs are diverted", () => {
  assert.ok(isBinaryRead(read()));
  assert.equal(
    isBinaryRead({ ...read(), url: "vscode://codex/read-file" }),
    false,
  );
  assert.equal(
    isOversizedDiagnosticLog({
      type: "log-message",
      message: "normal warning",
    }),
    false,
  );
  assert.equal(
    isOversizedDiagnosticLog({
      type: "log-message",
      tags: { payload: "x".repeat(5904569) },
    }),
    true,
  );
  assert.equal(
    isOversizedDiagnosticLog({
      type: "log-message",
      message: "中".repeat(8000),
    }),
    true,
  );
  assert.equal(
    isOversizedDiagnosticLog({
      type: "mcp-request",
      message: "x".repeat(5904569),
    }),
    false,
  );
});
