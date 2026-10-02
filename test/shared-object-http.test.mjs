import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import Fastify from "fastify";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { SharedObjectHttp } = await importTypescriptModule(
  "src/server/shared-object-http.ts",
);
const { SharedObjectHttpClient } = await importTypescriptModule(
  "src/browser/shared-object-http.ts",
);
const { installAuthHook } = await importTypescriptModule("src/server/auth.ts");
const endpoint = "/__backend/shared-object/statsig-evaluations";
const headers = {
  cookie: "codex_web_token=shared-secret",
  "content-type": "application/json",
};
const update = (value) => ({
  type: "ipc-main-event",
  channel: "codex_desktop:message-for-view",
  args: [{ type: "shared-object-updated", key: "statsig_evaluations", value }],
});
const publication = (value) => ({
  type: "shared-object-set",
  key: "statsig_evaluations",
  value,
});
const snapshot = (revision, value) =>
  new Response(JSON.stringify(update(value)), {
    headers: { "x-codex-shared-revision": String(revision) },
  });
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  // CompressionStream finishes on a worker; event-loop turns can run out before
  // that worker is scheduled when the full suite builds/compresses in parallel.
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition did not settle");
}
async function server(t, invoke = () => null) {
  const app = Fastify();
  installAuthHook(app, "shared-secret");
  const transport = new SharedObjectHttp();
  await transport.install(app, invoke);
  t.after(() => app.close());
  return { app, transport };
}
function client(t, request) {
  const received = [],
    errors = [];
  const transport = new SharedObjectHttpClient(
    (message) => received.push(message),
    (error) => errors.push(error),
    request,
  );
  transport.open();
  t.after(() => transport.close());
  return { transport, received, errors };
}

test("bulk snapshots require authentication and a live subscription; gzip preserves exact permissions and identity", async (t) => {
  const { app, transport } = await server(t);
  let subscribed = true;
  transport.connect("tab", () => subscribed);
  const value = {
    identity: { accountId: "test-account", userId: "test-user" },
    payload: "full-feature-values".repeat(300000),
    executionValues: { unifiedProjects: false },
  };
  const revision = transport.capture(update(value));
  const url = `${endpoint}?clientId=tab&revision=${revision}`;
  for (const method of ["GET", "POST"]) {
    const denied = await app.inject({
      method,
      url,
      ...(method === "POST" ? { payload: publication(null) } : {}),
    });
    assert.equal(denied.statusCode, 401);
  }
  const response = await app.inject({
    url,
    headers: { ...headers, "accept-encoding": "gzip" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.deepEqual(JSON.parse(gunzipSync(response.rawPayload)), update(value));
  assert.ok(response.rawPayload.length < 100000);
  const stale = await app.inject({
    url: `${endpoint}?clientId=tab&revision=0`,
    headers,
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.headers["x-codex-shared-revision"], String(revision));
  subscribed = false;
  assert.equal((await app.inject({ url, headers })).statusCode, 409);
  subscribed = true;
  transport.disconnect("tab");
  assert.equal((await app.inject({ url, headers })).statusCode, 409);
});

test("bulk publication calls the native handler once and rejects other keys, malformed data, oversized gzip and closed sessions", async (t) => {
  const calls = [];
  const { app, transport } = await server(t, (event) => {
    calls.push(event);
    return "native-result";
  });
  transport.connect("tab", () => false);
  const post = (body, extra = {}) =>
    app.inject({
      method: "POST",
      url: `${endpoint}?clientId=tab`,
      headers: { ...headers, ...extra },
      payload: body,
    });
  const event = publication({ accountId: "account", permission: false });
  assert.deepEqual(
    (
      await post(gzipSync(JSON.stringify(event)), {
        "content-encoding": "gzip",
      })
    ).json(),
    { result: "native-result" },
  );
  assert.deepEqual(calls, [event]);
  assert.equal(
    (await post({ ...event, key: "composer-draft" })).statusCode,
    400,
  );
  assert.equal((await post("malformed")).statusCode, 400);
  assert.equal((await post("x", { "content-encoding": "br" })).statusCode, 415);
  assert.equal(
    (
      await post(gzipSync("x".repeat(8 * 1024 * 1024 + 1)), {
        "content-encoding": "gzip",
      })
    ).statusCode,
    413,
  );
  assert.equal((await post("x".repeat(8 * 1024 * 1024 + 1))).statusCode, 413);
  transport.disconnect("tab");
  assert.equal((await post(event)).statusCode, 409);
  assert.equal(calls.length, 1);
});

test("bulk concurrency is bounded without delaying other authenticated routes", async (t) => {
  const pending = [];
  const { app, transport } = await server(
    t,
    () => new Promise((resolve) => pending.push(resolve)),
  );
  app.get("/health", () => "ready");
  transport.connect("tab", () => true);
  const invoke = () =>
    app.inject({
      method: "POST",
      url: `${endpoint}?clientId=tab`,
      headers,
      payload: publication(null),
    });
  const active = Array.from({ length: 4 }, () =>
    invoke().then((r) => r.statusCode),
  );
  await until(() => pending.length === 4);
  assert.equal((await invoke()).statusCode, 503);
  assert.equal((await app.inject({ url: "/health", headers })).body, "ready");
  pending.splice(0).forEach((resolve) => resolve(null));
  assert.deepEqual(await Promise.all(active), [200, 200, 200, 200]);
  transport.capture(update("x".repeat(8 * 1024 * 1024)));
  const unavailable = await app.inject({
    url: `${endpoint}?clientId=tab&revision=1`,
    headers,
  });
  assert.equal(unavailable.statusCode, 413);
});

test("late HTTP snapshots cannot overwrite a newer revision or a reconnected browser", async (t) => {
  const requests = [];
  const { transport, received, errors } = client(
    t,
    (url, init) =>
      new Promise((resolve) => requests.push({ url, init, resolve })),
  );
  transport.changed(1);
  transport.changed(2);
  assert.equal(requests.length, 1);
  requests[0].resolve(snapshot(1, "old identity"));
  await until(() => requests.length === 2);
  assert.equal(received.length, 0);
  requests[1].resolve(snapshot(2, "current identity"));
  await until(() => received.length === 1);
  assert.deepEqual(received, [update("current identity")]);
  transport.changed(3);
  await until(() => requests.length === 3);
  transport.close();
  assert.equal(requests[2].init.signal.aborted, true);
  requests[2].resolve(snapshot(3, "closed socket"));
  await tick();
  await tick();
  assert.equal(received.length, 1);
  assert.deepEqual(errors, []);
});

test("new publications suppress stale readbacks, preserve write order and never replay failed writes", async (t) => {
  const requests = [];
  const { transport, received } = client(
    t,
    (url, init) =>
      new Promise((resolve, reject) =>
        requests.push({ url, init, resolve, reject }),
      ),
  );
  transport.changed(1);
  const first = transport.publish(publication({ identity: "new" }));
  const second = transport.publish(publication(null));
  await until(() => requests.length === 2);
  assert.equal(requests[1].init.method, "POST");
  assert.equal(requests[1].init.cache, "no-store");
  assert.equal(requests[1].init.credentials, "same-origin");
  assert.deepEqual(
    JSON.parse(
      gunzipSync(Buffer.from(await requests[1].init.body.arrayBuffer())),
    ),
    publication({ identity: "new" }),
  );
  requests[0].resolve(snapshot(1, "old"));
  await tick();
  await tick();
  assert.equal(received.length, 0);
  requests[1].resolve(new Response('{"result":"first"}'));
  assert.equal(await first, "first");
  await until(() => requests.length === 3);
  assert.deepEqual(
    JSON.parse(
      gunzipSync(Buffer.from(await requests[2].init.body.arrayBuffer())),
    ),
    publication(null),
  );
  const rejected = assert.rejects(second, /connection failed/);
  requests[2].reject(new Error("connection failed"));
  await rejected;
  transport.close();
  assert.equal(requests.filter((r) => r.init.method === "POST").length, 2);
});

test("a snapshot replaced before GET follows the new revision without applying old values", async (t) => {
  const calls = [];
  const { transport, received } = client(t, async (url) => {
    calls.push(url);
    return calls.length === 1
      ? new Response("{}", {
          status: 409,
          headers: { "x-codex-shared-revision": "3" },
        })
      : snapshot(3, null);
  });
  transport.changed(1);
  await until(() => received.length === 1);
  assert.ok(calls[1].endsWith("revision=3"));
  assert.deepEqual(received, [update(null)]);
});
