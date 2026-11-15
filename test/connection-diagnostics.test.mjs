import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { createConnectionDiagnostics } = await importTypescriptModule(
  "src/browser/connection-diagnostics.ts",
);
const buildId = "26.1007.71326-cli1621-20261108-r17";
const response = (extra = {}) =>
  new Response(
    JSON.stringify({
      buildId,
      connections: 2,
      ports: 3,
      bufferedBytes: 0,
      chunkedIpc: { pendingTransfers: 1, oldestAckWaitMs: 400 },
      startup: [
        {
          method: "settings.readAll",
          phase: "reply",
          reason: "ok",
          elapsedMs: 20,
        },
      ],
      ...extra,
    }),
  );
const input = {
  buildId,
  browser: {
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1",
    online: true,
    visibility: "visible",
    secureContext: true,
    network: { effectiveType: "4g", rtt: 200, downlink: 1.2, saveData: false },
  },
  connection: {
    readyState: 1,
    generation: 4,
    reconnectAttempt: 2,
    recovering: true,
  },
  diagnostics: {
    ports: 3,
    pendingInvokes: 2,
    pendingAppRequests: 1,
    sendQueue: 0,
    appHost: {
      generation: 3,
      pending: 2,
      requiredPending: 1,
      subscriptions: 4,
      exhausted: false,
      stages: { configuration: { state: "completed", at: 100 } },
      requiredFailures: ["settings.readAll"],
      events: [
        {
          generation: 3,
          method: "config/read",
          phase: "configuration",
          reason: "timed-out",
          elapsedMs: 15_000,
          pending: 1,
        },
      ],
    },
    threadCache: {
      hits: 2,
      misses: 1,
      writes: 3,
      syncing: 0,
      errors: { QuotaExceededError: 1 },
    },
  },
};

test("offline export is synchronous and includes useful state without a server", () => {
  const collector = createConnectionDiagnostics({ now: () => 1000 });
  collector.record("socket-close", {
    code: 1006,
    wasClean: false,
    generation: 4,
  });
  const report = JSON.parse(collector.serialize(input));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.buildId, buildId);
  assert.equal(report.browser.family, "safari");
  assert.equal(report.browser.majorVersion, 18);
  assert.equal(report.browser.mobile, true);
  assert.equal(report.connection.generation, 4);
  assert.equal(report.diagnostics.appHost.events[0].reason, "timed-out");
  assert.equal(report.server.status, "not-requested");
  assert.equal(report.events[0].code, 1006);
});

test("lifecycle pause and finite retry budgets survive sanitization", () => {
  const collector = createConnectionDiagnostics();
  const state = structuredClone(input);
  state.connection.state = "waiting-network";
  state.connection.transportRemainingMs = 45_000;
  state.diagnostics.appHost.suspended = true;
  state.diagnostics.appHost.authenticationRequired = false;
  state.diagnostics.appHost.cycle = {
    retries: 1,
    remainingMs: 50_000,
    waiting: { secret: "do-not-export" },
  };
  collector.record("recovery-state", { state: "paused" });
  state.diagnostics.appHost.events.push({
    method: "services",
    phase: "resumed",
    reason: "",
    elapsedMs: 0,
  });
  const report = collector.snapshot(state);
  assert.equal(report.connection.state, "waiting-network");
  assert.equal(report.connection.transportRemainingMs, 45_000);
  assert.equal(report.events[0].state, "paused");
  assert.equal(report.diagnostics.appHost.authenticationRequired, false);
  assert.deepEqual(report.diagnostics.appHost.cycle, {
    retries: 1,
    remainingMs: 50_000,
  });
  assert.equal(report.diagnostics.appHost.events.at(-1).phase, "resumed");
  assert.ok(!JSON.stringify(report).includes("do-not-export"));
});

test("strict field and string allowlists remove secrets even in diagnostics object keys", async () => {
  const secret = "SENSITIVE_TOKEN_OR_DRAFT";
  const polluted = structuredClone(input);
  polluted.url = `https://private.example/thread/${secret}?token=${secret}`;
  polluted.browser.userAgent += ` ${secret}`;
  polluted.browser.href = secret;
  polluted.connection.reason = secret;
  polluted.connection.closeReason = secret;
  polluted.connection.hostId = secret;
  polluted.diagnostics.threadCache.errors[secret] = 7;
  polluted.diagnostics.appHost.requiredFailures.push(secret);
  polluted.diagnostics.appHost.stages[secret] = { state: secret };
  polluted.diagnostics.appHost.events.push({
    method: secret,
    phase: secret,
    reason: secret,
    params: secret,
    threadId: secret,
  });
  const collector = createConnectionDiagnostics();
  collector.record(secret, { reason: secret });
  collector.record("socket-error", {
    reason: secret,
    state: secret,
    code: secret,
    message: secret,
    token: secret,
  });
  await collector.collect(polluted, {
    fetch: async () =>
      response({
        token: secret,
        connectionId: secret,
        startup: [
          { method: secret, phase: secret, reason: secret, args: secret },
        ],
      }),
  });
  const text = collector.serialize(polluted);
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes("private.example"));
  assert.equal(JSON.parse(text).diagnostics.threadCache.errors.other, 7);
  assert.equal(JSON.parse(text).events.length, 1);
});

test("event ring, trace arrays and numeric values are bounded", () => {
  const collector = createConnectionDiagnostics({ maxEvents: 100_000 });
  for (let i = 0; i < 1000; i++)
    collector.record("reconnect-scheduled", {
      attempt: i,
      delayMs: Infinity,
      elapsedMs: -1,
    });
  const polluted = structuredClone(input);
  polluted.diagnostics.appHost.events = Array.from({ length: 1000 }, () => ({
    method: "config/read",
    phase: "begin",
    elapsedMs: 1,
  }));
  const report = collector.snapshot(polluted);
  assert.equal(report.events.length, 200);
  assert.equal(report.droppedEvents, 800);
  assert.equal(report.events[0].attempt, 800);
  assert.equal(report.events[0].delayMs, undefined);
  assert.equal(report.events[0].elapsedMs, undefined);
  assert.equal(report.diagnostics.appHost.events.length, 200);
  assert.ok(collector.serialize(polluted).length < 150_000);
  report.events[0].attempt = -200;
  assert.equal(collector.snapshot().events[0].attempt, 800);
});

test("server collection is same-origin, no-store and keeps the last snapshot offline", async () => {
  let now = 10;
  const collector = createConnectionDiagnostics({ now: () => now });
  const result = await collector.collect(input, {
    fetch: async (url, init) => {
      assert.equal(url, "/__backend/diagnostics");
      assert.equal(init.credentials, "same-origin");
      assert.equal(init.cache, "no-store");
      assert.equal(init.redirect, "error");
      return response();
    },
  });
  assert.equal(result.server.status, "ok");
  assert.equal(result.server.diagnostics.chunkedIpc.pendingTransfers, 1);
  result.server.diagnostics.connections = 500;
  now = 110;
  const offline = await collector.collect(input, {
    online: false,
    fetch: () => {
      throw new Error("must not request");
    },
  });
  assert.equal(offline.server.status, "offline");
  assert.equal(offline.server.ageMs, 100);
  assert.equal(offline.server.diagnostics.connections, 2);
});

test("timeout returns local state even if fetch ignores AbortSignal; late response is discarded", async () => {
  const collector = createConnectionDiagnostics();
  let resolve, signal;
  const report = await collector.collect(input, {
    timeoutMs: 5,
    fetch: (_url, init) => {
      signal = init.signal;
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  assert.equal(report.server.status, "timeout");
  assert.equal(report.diagnostics.pendingInvokes, 2);
  assert.equal(signal.aborted, true);
  resolve(response());
  await new Promise((r) => setImmediate(r));
  assert.equal(collector.snapshot().server.status, "timeout");
  assert.equal(collector.snapshot().server.diagnostics, undefined);
});

test("timeout includes body reads and stale fetch generations cannot replace current evidence", async () => {
  const collector = createConnectionDiagnostics();
  const hangingBody = new Response(new ReadableStream({ start() {} }));
  const timedOut = await collector.collect(input, {
    timeoutMs: 5,
    fetch: async () => hangingBody,
  });
  assert.equal(timedOut.server.status, "timeout");
  let resolve;
  const earlier = collector.collect(input, {
    fetch: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  await collector.collect(input, {
    fetch: async () => response({ connections: 9 }),
  });
  resolve(response({ connections: 1 }));
  await earlier;
  assert.equal(collector.snapshot().server.diagnostics.connections, 9);
});

test("network, HTTP, authentication and malformed data failures remain locally exportable", async () => {
  const collector = createConnectionDiagnostics();
  await collector.collect(input, { fetch: async () => response() });
  for (const [fetch, expected] of [
    [
      async () => {
        throw new Error("secret transport error");
      },
      "network-error",
    ],
    [
      async () => new Response("secret upstream error", { status: 503 }),
      "http-error",
    ],
    [async () => new Response("not JSON"), "invalid-response"],
    [async () => new Response("[]"), "invalid-response"],
    [
      async () =>
        new Response("{}", {
          headers: { "content-length": String(1024 * 1024) },
        }),
      "invalid-response",
    ],
    [
      async () => new Response("unauthorized", { status: 401 }),
      "authentication",
    ],
  ]) {
    const report = await collector.collect(input, { fetch });
    assert.equal(report.server.status, expected);
    assert.equal(report.diagnostics.ports, 3);
    assert.ok(!JSON.stringify(report).includes("secret"));
  }
  assert.equal(collector.snapshot().server.diagnostics, undefined);
});

test("oversize streamed responses cannot allocate unbounded exported data", async () => {
  const collector = createConnectionDiagnostics();
  const report = await collector.collect(input, {
    fetch: async () => new Response(" ".repeat(256 * 1024 + 1)),
  });
  assert.equal(report.server.status, "invalid-response");
  assert.ok(JSON.stringify(report).length < 10_000);
});

test("clearing authenticated evidence also prevents late requests restoring it", async () => {
  const collector = createConnectionDiagnostics();
  let resolve;
  const pending = collector.collect(input, {
    fetch: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  collector.clearServerSnapshot();
  resolve(response());
  await pending;
  assert.equal(collector.snapshot().server.status, "not-requested");
  assert.equal(collector.snapshot().server.diagnostics, undefined);
});
