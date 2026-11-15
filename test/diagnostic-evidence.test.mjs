import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";
import { nativeRequestClient } from "./desktop-request-harness.mjs";

const { DiagnosticJournal } = await importTypescriptModule(
  "src/browser/diagnostic-journal.ts",
);
const { DiagnosticRuntime } = await importTypescriptModule(
  "src/browser/diagnostic-runtime.ts",
);
const { ServerDiagnosticRecorder } = await importTypescriptModule(
  "src/server/diagnostic-recorder.ts",
);
const { createConnectionDiagnostics } = await importTypescriptModule(
  "src/browser/connection-diagnostics.ts",
);
const { installDiagnosticObservers } = await importTypescriptModule(
  "src/browser/diagnostic-browser.ts",
);
function fixture(t, storage) {
  let now = 1000;
  const journal = new DiagnosticJournal({
    now: () => now,
    mono: () => now,
    storage,
    random: () => `fixture-${Math.random()}`,
  });
  const runtime = new DiagnosticRuntime(journal, () => ({
    hostId: "remote-fixture",
    threadId: "thread-fixture",
  }));
  runtime.clientId = "b527092e-629b-4c99-acb2-bbaf9b5df8d7";
  t.after(() => journal.dispose());
  return {
    journal,
    runtime,
    advance: (ms) => {
      now += ms;
    },
  };
}
function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
    data,
  };
}

test("startup survives request floods; overlapping background/offline time is counted once", (t) => {
  const { journal, advance } = fixture(t);
  journal.milestone("socket", "begin");
  advance(900);
  journal.milestone("socket", "end");
  const read = journal.begin("get-global-state", {
    required: true,
    remainingMs: 15000,
  });
  advance(1000);
  journal.lifecycle("visibility", { hidden: true });
  advance(1000);
  journal.lifecycle("offline", { online: false });
  advance(3000);
  journal.lifecycle("visibility", { hidden: false });
  advance(2000);
  journal.lifecycle("online", { online: true });
  advance(2000);
  const pending = journal.pendingDetails()[0];
  assert.equal(pending.elapsedMs, 9000);
  assert.equal(pending.activeElapsedMs, 3000);
  assert.equal(pending.remainingMs, 12000);
  journal.end(read);
  for (let i = 0; i < 1400; i++)
    journal.record("requests", {
      method: "settings.subscribe",
      phase: "end",
      reason: "ok",
    });
  const report = journal.snapshot();
  assert.equal(report.startup.length, 2);
  assert.equal(report.requests.events.length, 1000);
  assert.ok(report.requests.dropped >= 402);
  assert.deepEqual(report.intervals, {
    activeMs: 3900,
    backgroundMs: 4000,
    offlineMs: 2000,
  });
  assert.equal(report.durationMs, 9900);
});

test("the reported seven timeouts remain visible independently of healthy connection and subsequent traffic", (t) => {
  const { journal, advance } = fixture(t);
  journal.lifecycle("connected");
  for (let i = 0; i < 7; i++) {
    const id = journal.begin("get-global-state", { layer: "ipc" });
    advance(15000);
    journal.end(
      id,
      Object.assign(new Error("连接或读取超时，草稿已保留。"), {
        name: "CodexWebTransportError",
      }),
    );
  }
  for (let i = 0; i < 1200; i++)
    journal.record("requests", { method: "settings.subscribe", reason: "ok" });
  const report = journal.snapshot();
  assert.equal(report.errors.events.length, 7);
  assert.ok(
    report.errors.events.every(
      (e) => e.reason === "timeout" && e.elapsedMs === 15000,
    ),
  );
  assert.equal(report.lifecycle.events[0].phase, "connected");
});

test("IPC ACK is not acceptance; reply, rejection, not-sent and unknown outcomes stay distinct", (t) => {
  const { journal, runtime } = fixture(t);
  function start(id) {
    const options = {},
      op = runtime.start(options);
    runtime.bindMessage(`message-${id}`, op);
    runtime.registerNative(
      "remote-fixture",
      id,
      "turn/start",
      { threadId: "thread-fixture", input: "private draft" },
      { clientUserMessageId: `message-${id}` },
    );
    return op;
  }
  const accepted = start("one");
  runtime.delivered("remote-fixture", "one", "dispatched");
  runtime.delivered("remote-fixture", "one", "acknowledged");
  assert.equal(
    journal.snapshot().operations.find((v) => v.id === accepted).outcome,
    "outcome-unknown",
  );
  runtime.nativeEvent({
    hostId: "remote-fixture",
    id: "one",
    method: "turn/start",
    type: "completed",
    result: { turn: { id: "turn-one" } },
  });
  runtime.notification("remote-fixture", "item/agentMessage/delta", {
    turnId: "turn-one",
    delta: "private response",
  });
  assert.equal(
    journal.snapshot().operations.find((v) => v.id === accepted).phase,
    "first-response",
  );
  const rejected = start("two");
  runtime.delivered("remote-fixture", "two", "dispatched");
  runtime.backendReply("remote-fixture", {
    id: "two",
    error: { code: -32602 },
  });
  runtime.nativeEvent({
    hostId: "remote-fixture",
    id: "two",
    method: "turn/start",
    type: "failed",
    error: Object.assign(new Error("Permission denied private path"), {
      code: -32602,
    }),
  });
  assert.equal(
    journal.snapshot().operations.find((v) => v.id === rejected).outcome,
    "rejected-backend",
  );
  const unknown = start("three");
  runtime.delivered("remote-fixture", "three", "dispatched");
  const unsent = start("four");
  runtime.disconnected();
  assert.equal(
    journal.snapshot().operations.find((v) => v.id === unknown).outcome,
    "outcome-unknown",
  );
  assert.equal(
    journal.snapshot().operations.find((v) => v.id === unsent).outcome,
    "not-sent",
  );
  const text = JSON.stringify(journal.snapshot());
  for (const secret of [
    "private draft",
    "private response",
    "private path",
    "remote-fixture",
    "thread-fixture",
    "turn-one",
  ])
    assert.ok(!text.includes(secret));
});

test("submission preparation and toast errors retain causal IDs without attaching background reads", (t) => {
  const { journal, runtime } = fixture(t),
    options = {},
    id = runtime.start(options);
  const copy = { ...options };
  assert.equal(runtime.id(copy), id);
  assert.equal(JSON.stringify(copy), "{}");
  runtime.registerNative(
    "remote-fixture",
    "config",
    "config/read",
    {},
    runtime.tag({}, id),
  );
  runtime.registerNative(
    "remote-fixture",
    "background",
    "get-global-state",
    {},
    {},
  );
  const failure = new Error("连接或读取超时，草稿已保留。");
  runtime.fail(id, failure, "configuration");
  runtime.toast(failure);
  const report = journal.snapshot();
  assert.equal(report.operations[0].outcome, "not-sent");
  assert.ok(
    report.errors.events.some(
      (e) =>
        e.method === "toast" &&
        e.operationId === id &&
        e.message === failure.message,
    ),
  );
  assert.equal(
    report.requests.events.find((e) => e.method === "get-global-state")
      .operationId,
    undefined,
  );
});

test("persisted evidence is re-sanitized, expires at thirty minutes and clears on identity changes", (t) => {
  const storage = memoryStorage(),
    first = fixture(t, storage);
  first.journal.identityChanged("opaque-backend-identity");
  first.journal.error(
    new Error("secret-body Bearer token /private/path?secret=value"),
  );
  first.journal.flush();
  const raw = storage.getItem("codex-web-diagnostics-v2");
  assert.ok(!raw.includes("secret-body"));
  const poisoned = JSON.parse(raw);
  poisoned.pages[0].errors.events[0].message = "injected secret";
  poisoned.pages[0].errors.events[0].token = "token";
  storage.setItem("codex-web-diagnostics-v2", JSON.stringify(poisoned));
  const second = fixture(t, storage);
  assert.equal(second.journal.snapshot().previousPages.length, 1);
  assert.ok(
    !JSON.stringify(second.journal.snapshot()).includes("injected secret"),
  );
  second.journal.identityChanged("another-opaque-identity");
  assert.equal(second.journal.snapshot().previousPages.length, 0);
  second.journal.error(new Error("Timeout"));
  second.journal.flush();
  second.advance(30 * 60000 + 1);
  assert.equal(second.journal.snapshot().errors.events.length, 0);
});

test("storage failure, floods and corrupted data never prevent export", (t) => {
  const { journal } = fixture(t, {
    getItem: () => null,
    setItem() {
      throw new Error("quota");
    },
    removeItem() {},
  });
  journal.error(new Error("Timeout"));
  journal.flush();
  assert.equal(journal.snapshot().storage.status, "quota");
  const storage = memoryStorage(),
    large = fixture(t, storage);
  for (let i = 0; i < 1500; i++) {
    large.journal.begin("get-global-state");
    large.journal.error(new Error(`private failure ${i}`));
  }
  large.journal.flush();
  assert.ok(
    Buffer.byteLength(storage.getItem("codex-web-diagnostics-v2")) <=
      1024 * 1024,
  );
  const collector = createConnectionDiagnostics({
    evidence: () => large.journal.snapshot(),
  });
  const exported = collector.serialize();
  assert.ok(Buffer.byteLength(exported) <= 2 * 1024 * 1024);
  assert.equal(JSON.parse(exported).schemaVersion, 2);
  storage.setItem("codex-web-diagnostics-v2", "invalid");
  const corrupt = fixture(t, storage);
  assert.equal(corrupt.journal.snapshot().storage.status, "corrupt");
});

test("server and browser share anonymous request IDs, isolate peers, and never retain bodies", (t) => {
  const server = new ServerDiagnosticRecorder();
  t.after(() => server.dispose());
  const { runtime, journal } = fixture(t),
    client = runtime.clientId;
  server.open(client);
  server.open("other-client");
  const event = {
    type: "fetch",
    requestId: "native-id",
    url: "vscode://codex/get-global-state",
    body: '{"key":"private setting"}',
  };
  runtime.fetchStart("native-id", event.url, { body: event.body });
  server.request(client, event, "received", "ipc-id");
  server.request(client, event, "begin");
  server.request(client, event, "end");
  runtime.fetchEnd("native-id", undefined, 200);
  const report = server.snapshot(client);
  assert.equal(
    report.events[0].requestId,
    journal.snapshot().requests.events[0].requestId,
  );
  assert.equal(server.snapshot("other-client").events.length, 0);
  assert.ok(!JSON.stringify(report).includes("private setting"));
  assert.ok(report.events.find((e) => e.phase === "end").handlerMs >= 0);
});

test("unsupported performance APIs and rejected HTTP calls remain visible without changing results", async (t) => {
  const { journal } = fixture(t);
  const doc = new EventTarget();
  doc.visibilityState = "visible";
  const target = new EventTarget();
  target.document = doc;
  target.location = {
    origin: "https://example.invalid",
    href: "https://example.invalid/",
  };
  target.navigator = { onLine: true };
  const failure = new Error("Failed to fetch");
  target.fetch = async () => {
    throw failure;
  };
  const original = target.fetch,
    dispose = installDiagnosticObservers(journal, target);
  t.after(dispose);
  await assert.rejects(
    target.fetch("/__backend/upload"),
    (error) => error === failure,
  );
  const report = journal.snapshot();
  assert.ok(
    report.performanceSummary.capabilities.some(
      (e) => e.capability === "longTasks" && e.supported === false,
    ),
  );
  assert.ok(report.errors.events.some((e) => e.method === "upload"));
  dispose();
  assert.equal(target.fetch, original);
});

test("real Desktop request scheduling preserves causal IDs and unknown delivery without duplicate writes", async (t) => {
  const { journal } = fixture(t),
    runtime = new DiagnosticRuntime(journal);
  const dispatched = [];
  const { client } = await nativeRequestClient(
    (_type, { request }) => {
      dispatched.push(request);
      runtime.delivered("local", request.id, "dispatched");
    },
    (event) => runtime.nativeEvent(event),
    undefined,
    runtime,
  );
  const options = { trace: null },
    operationId = runtime.start(options, "steer");
  const promise = client.sendRequest(
    "turn/steer",
    { threadId: "private-thread", input: "secret-draft" },
    options,
  );
  assert.equal(dispatched.length, 1);
  const request = dispatched[0];
  runtime.delivered("local", request.id, "acknowledged");
  assert.equal(journal.snapshot().operations[0].outcome, "outcome-unknown");
  runtime.backendReply("local", { id: request.id, result: {} });
  client.onResult(request.id, { turnId: "turn-id" });
  await promise;
  assert.equal(journal.snapshot().operations[0].outcome, "accepted");
  assert.ok(
    journal
      .snapshot()
      .requests.events.some(
        (e) => e.operationId === operationId && e.method === "turn/steer",
      ),
  );
  assert.equal(dispatched.length, 1);
  assert.ok(!JSON.stringify(journal.snapshot()).includes("secret-draft"));
});

test("storage expires on reload, tabs stay separate, and terminal outcomes cannot regress after a late ACK", (t) => {
  const storage = memoryStorage(),
    first = fixture(t, storage);
  const id = first.journal.startOperation();
  first.journal.step(id, "accepted", { outcome: "accepted" });
  first.journal.step(id, "acknowledged", { outcome: "outcome-unknown" });
  assert.equal(first.journal.snapshot().operations[0].outcome, "accepted");
  first.journal.flush();
  const expired = new DiagnosticJournal({ storage, now: () => 1_801_001 });
  t.after(() => expired.dispose());
  assert.equal(expired.snapshot().previousPages.length, 0);
  assert.equal(expired.snapshot().storage.status, "expired");
  const other = fixture(t, memoryStorage());
  assert.equal(other.journal.snapshot().previousPages.length, 0);
  assert.notEqual(first.journal.pageId, other.journal.pageId);
});

test("refresh floods preserve previous submission results and startup while applying tab-wide event caps", (t) => {
  const storage = memoryStorage(),
    first = fixture(t, storage);
  first.journal.milestone("startup", "ready");
  const id = first.journal.startOperation();
  first.journal.step(id, "accepted", { outcome: "accepted" });
  first.journal.error(new Error("Timeout"), { operationId: id });
  for (let i = 0; i < 1000; i++)
    first.journal.record("requests", {
      method: "settings.subscribe",
      phase: "completed",
    });
  first.journal.flush();
  const second = fixture(t, storage);
  for (let i = 0; i < 1200; i++)
    second.journal.record("requests", {
      method: "get-global-state",
      phase: "completed",
    });
  second.journal.flush();
  const third = fixture(t, storage),
    report = third.journal.snapshot();
  assert.equal(report.previousPages.length, 2);
  assert.ok(
    report.previousPages[0].operations.some(
      (o) => o.id === id && o.outcome === "accepted",
    ),
  );
  assert.equal(report.previousPages[0].startup[0].method, "startup");
  assert.equal(report.previousPages[0].errors.events[0].operationId, id);
  assert.ok(report.previousPages[0].requests.truncated);
  assert.ok(
    [report, ...report.previousPages].reduce(
      (n, p) => n + p.requests.events.length,
      0,
    ) <= 1000,
  );
  assert.ok(
    Buffer.byteLength(storage.getItem("codex-web-diagnostics-v2")) <=
      1024 * 1024,
  );
});

test("a completed local queue action without a business reply is unknown and does not poll while idle", (t) => {
  const { journal, advance } = fixture(t);
  const id = journal.startOperation("follow-up");
  journal.step(id, "queued"); journal.step(id, "unlocked", { locked: false }); advance(4000);
  assert.equal(journal.snapshot().operations[0].outcome, "outcome-unknown");
  assert.equal(journal.hasSlowActivity(), false);
});

test("selected server records survive healthy idle periods and detailed snapshots stay bounded", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const server = new ServerDiagnosticRecorder();
  t.after(() => server.dispose());
  server.open("client");
  server.request(
    "client",
    { requestId: "one", url: "vscode://codex/get-global-state" },
    "received",
  );
  t.mock.timers.tick(300_001);
  assert.equal(server.snapshot("client").status, "available");
  assert.equal(server.snapshot("client").events.length, 0);
  for (let i = 0; i < 700; i++)
    server.record("client", {
      phase: "reply",
      method: "get-global-state",
      requestId: server.alias(i, "client"),
      successful: true,
    });
  const report = server.snapshot("client");
  assert.equal(report.events.length, 500);
  assert.ok(report.dropped >= 201);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 192 * 1024);
});
