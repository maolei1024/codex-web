import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import Fastify from "fastify";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { installFeatureConfigRoute } = await importTypescriptModule(
  "src/server/feature-config.ts",
);
const { installAuthHook } = await importTypescriptModule("src/server/auth.ts");
const { configureStatsigOptions } = await importTypescriptModule(
  "src/browser/statsig-network.ts",
);
const headers = {
  cookie: "codex_web_token=web-secret",
  "content-type": "application/json",
};

async function fixture(t, request, options = {}) {
  const app = Fastify();
  installAuthHook(app, "web-secret");
  await installFeatureConfigRoute(app, { request, ...options });
  t.after(() => app.close());
  return app;
}

test("feature configuration requires Web authentication before contacting upstream", async (t) => {
  const app = await fixture(t, () =>
    assert.fail("unauthorized upstream access"),
  );
  const response = await app.inject({
    method: "POST",
    url: "/__backend/feature-config",
    payload: "{}",
    headers: { "content-type": "application/json" },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers["cache-control"], "no-store");
});

test("configuration forwards SDK bytes to the fixed origin without Web or account credentials", async (t) => {
  const payload = Buffer.from([0, 1, 255, 10, 128]);
  const app = await fixture(t, async (url, init) => {
    assert.equal(
      String(url),
      "https://ab.chatgpt.com/v1/initialize?k=client-sdk&gz=1",
    );
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.deepEqual(Buffer.from(init.body), payload);
    assert.deepEqual(Object.fromEntries(init.headers), {
      "content-type": "application/octet-stream",
      "statsig-api-key": "client-sdk",
      "statsig-sdk-type": "js-client",
    });
    return new Response('{"feature_gates":{"ultra":{"value":false}}}', {
      headers: {
        "content-type": "application/json",
        "set-cookie": "must-not-forward=1",
      },
    });
  });
  const response = await app.inject({
    method: "POST",
    url: "/__backend/feature-config?k=client-sdk&gz=1&token=web-secret&url=https://example.invalid",
    payload,
    headers: {
      ...headers,
      "content-type": "application/octet-stream",
      authorization: "Bearer account-secret",
      "statsig-api-key": "client-sdk",
      "statsig-sdk-type": "js-client",
      "x-forwarded-host": "example.invalid",
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(response.json().feature_gates.ultra.value, false);
});

test("large configurations use gzip without changing upstream values or caching them", async (t) => {
  const payload = JSON.stringify({ values: "configuration".repeat(40000) });
  const app = await fixture(
    t,
    async () =>
      new Response(payload, {
        headers: { "content-type": "application/json" },
      }),
  );
  for (const encoding of ["gzip, deflate, br", "gzip;q=0"]) {
    const response = await app.inject({
      method: "POST",
      url: "/__backend/feature-config",
      headers: { ...headers, "accept-encoding": encoding },
      payload: "{}",
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers.vary, "Accept-Encoding");
    assert.equal(response.headers["cache-control"], "no-store");
    if (encoding.includes("q=0")) {
      assert.equal(response.headers["content-encoding"], undefined);
      assert.equal(response.body, payload);
    } else {
      assert.equal(response.headers["content-encoding"], "gzip");
      assert.equal(gunzipSync(response.rawPayload).toString(), payload);
      assert.ok(response.rawPayload.length < payload.length / 10);
    }
  }
});

test("upstream denials remain denials and oversized requests never reach upstream", async (t) => {
  let calls = 0;
  const app = await fixture(t, async () => {
    calls++;
    return new Response("denied", { status: 403 });
  });
  const denied = await app.inject({
    method: "POST",
    url: "/__backend/feature-config",
    headers,
    payload: "{}",
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body, "denied");
  const oversized = await app.inject({
    method: "POST",
    url: "/__backend/feature-config",
    headers,
    payload: "x".repeat(1024 * 1024 + 1),
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(calls, 1);
});

test("oversized upstream data and timeouts fail explicitly without fabricating configuration", async (t) => {
  const large = await fixture(
    t,
    async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)),
  );
  assert.equal(
    (
      await large.inject({
        method: "POST",
        url: "/__backend/feature-config",
        headers,
        payload: "{}",
      })
    ).statusCode,
    502,
  );
  const slow = await fixture(
    t,
    (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
    { timeoutMs: 40 },
  );
  await slow.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(
    `http://127.0.0.1:${slow.server.address().port}/__backend/feature-config`,
    {
      method: "POST",
      headers: { ...headers, connection: "close" },
      body: "{}",
    },
  );
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), {
    error: "feature configuration request failed",
  });
});

test("concurrent configuration fetches are bounded and capacity is released", async (t) => {
  const pending = [];
  const app = await fixture(
    t,
    () => new Promise((resolve) => pending.push(resolve)),
  );
  const invoke = () =>
    app.inject({
      method: "POST",
      url: "/__backend/feature-config",
      headers,
      payload: "{}",
    });
  const active = Array.from({ length: 4 }, () =>
    invoke().then((r) => r.statusCode),
  );
  while (pending.length < 4) await new Promise((r) => setTimeout(r, 1));
  assert.equal((await invoke()).statusCode, 503);
  pending.splice(0).forEach((resolve) => resolve(new Response("{}")));
  assert.deepEqual(await Promise.all(active), [200, 200, 200, 200]);
  const next = invoke().then((r) => r.statusCode);
  while (pending.length < 1) await new Promise((r) => setTimeout(r, 1));
  pending[0](new Response("{}"));
  assert.equal(await next, 200);
});

test("browser routes only native Statsig initialization through authenticated HTTP", async () => {
  const calls = [];
  const native = async (...args) => {
    calls.push(["native", ...args]);
    return new Response("native");
  };
  const http = async (...args) => {
    calls.push(["http", ...args]);
    return new Response("upstream");
  };
  const options = {
    disableStorage: true,
    networkConfig: {
      networkOverrideFunc: native,
      logEventUrl: "https://events.invalid",
    },
  };
  const adapted = configureStatsigOptions(options, http);
  const body = new Uint8Array([0, 255]);
  const signal = new AbortController().signal;
  const init = {
    method: "POST",
    body,
    signal,
    headers: { "STATSIG-API-KEY": "client-sdk" },
  };
  const response = await adapted.networkConfig.networkOverrideFunc(
    "https://ab.chatgpt.com/v1/initialize?k=client-sdk",
    init,
  );
  assert.equal(await response.text(), "upstream");
  assert.equal(calls[0][0], "http");
  assert.equal(calls[0][1], "/__backend/feature-config?k=client-sdk");
  assert.equal(calls[0][2].body, body);
  assert.equal(calls[0][2].signal, signal);
  assert.equal(calls[0][2].credentials, "same-origin");
  assert.equal(calls[0][2].cache, "no-store");
  assert.equal(calls[0][2].redirect, "error");
  assert.equal(adapted.disableStorage, true);
  assert.equal(options.networkConfig.networkOverrideFunc, native);
  for (const url of [
    "http://ab.chatgpt.com/v1/initialize",
    "https://ab.chatgpt.com.evil.invalid/v1/initialize",
    "https://ab.chatgpt.com:1234/v1/initialize",
    "https://ab.chatgpt.com/v1/sdk_exception",
    "https://api.oaistatsig.com/v1/rgstr",
    "https://user@ab.chatgpt.com/v1/initialize",
  ]) {
    await adapted.networkConfig.networkOverrideFunc(url, init);
    assert.equal(calls.at(-1)[0], "native", url);
  }
});
