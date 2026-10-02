import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { importTypescriptModule } from "./import-typescript-module.mjs";
import { nativeRequestClient } from "./desktop-request-harness.mjs";

const channel = "codex_desktop:message-from-view";
const incoming = "codex_desktop:message-for-view";
const modules = Object.fromEntries(
  await Promise.all(
    [
      "rpc-lifecycle",
      "reconnect-recovery",
      "connection-watchdog",
      "shared-object-subscriptions",
      "reconnect",
      "app-host-recovery",
      "crypto-compat",
    ].map(async (name) => [
      `./${name}`,
      await importTypescriptModule(`src/browser/${name}.ts`),
    ]),
  ),
);
const shimSource = ts.transpileModule(
  await readFile("src/browser/shim.ts", "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

function setup(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const sockets = [],
    windowEvents = new Map(),
    documentEvents = new Map();
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    listeners = new Map();
    sent = [];
    constructor() {
      sockets.push(this);
    }
    addEventListener(type, fn) {
      this.listeners.set(type, fn);
    }
    fire(type, event = {}) {
      this.listeners.get(type)?.(event);
    }
    open() {
      this.readyState = 1;
      this.fire("open");
    }
    send(value) {
      this.sent.push(JSON.parse(value));
    }
    close() {
      this.readyState = 3;
      this.fire("close");
    }
    receive(value) {
      this.fire("message", { data: JSON.stringify(value) });
    }
    view(value) {
      this.receive({
        type: "ipc-main-event",
        channel: incoming,
        args: [value],
      });
    }
  }
  const window = {
    crypto: webcrypto,
    location: {
      protocol: "https:",
      host: "example.test",
      pathname: "/",
      search: "",
    },
    history: {},
    setTimeout,
    clearTimeout,
    addEventListener: (type, fn) => windowEvents.set(type, fn),
  };
  const exports = {};
  vm.runInNewContext(shimSource, {
    exports,
    window,
    Date,
    setTimeout,
    clearTimeout,
    WebSocket: Socket,
    URLSearchParams,
    document: {
      visibilityState: "visible",
      addEventListener: (type, fn) => documentEvents.set(type, fn),
    },
    matchMedia: () => ({ matches: false }),
    console: { info() {}, error() {} },
    __CODEX_APP_VERSION__: "test",
    __CODEX_WEB_BUILD_ID__: "test",
    require: (name) =>
      modules[name] ??
      {
        "./routes": {
          mapBrowserPathToInitialRoute: () => ({ memoryPath: "/" }),
        },
        "./files": {
          installBrowserFileUploadBridge() {},
          isLocalFilePickerMessage: () => false,
        },
        "./mobile-viewport": { installMobileViewportGuard() {} },
        "./recovery-notice": { recoveryNotice() {}, checkForUpdate() {} },
      }[name] ??
      {},
  });
  return {
    sockets,
    window,
    ipc: exports.ipcRenderer,
    foreground: () => documentEvents.get("visibilitychange")(),
    pageshow: () => windowEvents.get("pageshow")({ persisted: true }),
  };
}

async function clientFor(bridge) {
  const { client } = await nativeRequestClient((type, message) => {
    // This is the Desktop dispatcher's behavior: rejected invokes are only logged.
    bridge.ipc.invoke(channel, { type, ...message }).catch(() => {});
  }, bridge.window.__ELECTRON_SHIM__.appServerRequestLifecycle);
  bridge.ipc.on(incoming, (_event, message) => {
    if (message.type === "mcp-request-delivery")
      client.onDelivery(message.update);
    if (message.type === "mcp-response")
      client.onResult(String(message.message.id), message.message.result);
  });
  return client;
}

test("AppHost startup waits for the real shared snapshot before mounting remote routes", async (t) => {
  const bridge = setup(t),
    socket = bridge.sockets[0];
  socket.open();
  const events = [];
  bridge.ipc.on(incoming, (_event, message) => events.push(message));
  let ready = false;
  const boot = bridge.window.__ELECTRON_SHIM__
    .configureAppHost(() => ({
      services: Promise.resolve({ settings: {} }),
      close() {},
    }))
    .then(() => {
      ready = true;
    });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  const request = socket.sent.find(
    (x) => x.channel === "codex_desktop:get-shared-object-snapshot",
  );
  assert.ok(request);
  assert.equal(ready, false);
  socket.receive({
    type: "ipc-renderer-invoke-result",
    requestId: request.requestId,
    ok: true,
    result: { remote_ssh_connections: [{ hostId: "remote-test" }] },
  });
  await boot;
  assert.equal(ready, true);
  assert.equal(events[0].key, "remote_ssh_connections");
  assert.equal(events[0].value[0].hostId, "remote-test");
  assert.equal(bridge.window.__ELECTRON_SHIM__.diagnostics().pendingInvokes, 0);
});

test("expired snapshot reads clean up IPC tracking and ignore late replies", async (t) => {
  const bridge = setup(t),
    socket = bridge.sockets[0];
  socket.open();
  const events = [];
  bridge.ipc.on(incoming, (_event, message) => events.push(message));
  const boot = bridge.window.__ELECTRON_SHIM__.configureAppHost(() => ({
    services: Promise.resolve({ settings: {} }),
    close() {},
  }));
  const rejected = assert.rejects(boot);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  const request = socket.sent.find(
    (x) => x.channel === "codex_desktop:get-shared-object-snapshot",
  );
  t.mock.timers.tick(60_001);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await rejected;
  assert.equal(bridge.window.__ELECTRON_SHIM__.diagnostics().pendingInvokes, 0);
  socket.receive({
    type: "ipc-renderer-invoke-result",
    requestId: request.requestId,
    ok: true,
    result: { remote_ssh_connections: [{ hostId: "stale" }] },
  });
  assert.equal(events.length, 0);
});

test("real bridge rejects native requests even after IPC ack, and never replays a lost turn", async (t) => {
  const bridge = setup(t);
  const client = await clientFor(bridge);
  const first = bridge.sockets[0];
  first.open();
  const request = client.sendRequest("turn/start", {}, { trace: null });
  const rejected = assert.rejects(
    request,
    (error) => error.delivery.stage === "outcome-unknown",
  );
  first.receive({
    type: "ipc-renderer-invoke-result",
    requestId: first.sent[0].requestId,
    ok: true,
  });
  first.close();
  await rejected;
  const offline = client.sendRequest("turn/steer", {}, { trace: null });
  await assert.rejects(offline, (error) => error.delivery.stage === "not-sent");
  bridge.foreground();
  bridge.sockets.at(-1).open();
  assert.equal(
    bridge.sockets.at(-1).sent.filter((event) => event.args?.[0]?.request)
      .length,
    0,
  );
  assert.equal(client.getPendingRequestCount(), 0);
});

test("native completion before IPC ack removes the tracked request, including on later disconnect", async (t) => {
  const bridge = setup(t),
    client = await clientFor(bridge);
  const socket = bridge.sockets[0];
  socket.open();
  const request = client.sendRequest("configRequirements/read", undefined, {
    trace: null,
  });
  socket.view({
    type: "mcp-response",
    hostId: "local",
    message: { id: "native-1", result: { requirements: null } },
  });
  await request;
  socket.close();
  assert.equal(client.getPendingRequestCount(), 0);
});

test("an internal AppHost disconnect settles acknowledged native resumes while the WebSocket stays open", async (t) => {
  const bridge = setup(t),
    client = await clientFor(bridge);
  const socket = bridge.sockets[0];
  socket.open();
  const coordinator = bridge.window.__ELECTRON_SHIM__.appHost;
  for (let attempt = 0; attempt < 3; attempt++) {
    const resume = client.sendRequest(
      "thread/resume",
      { threadId: "fixture" },
      { timeoutMs: 0, trace: null },
    );
    const write = client.sendRequest(
      "turn/start",
      {},
      { trace: null, timeoutMs: 0 },
    );
    const rejectedResume = assert.rejects(resume, /Connection interrupted/);
    const rejectedWrite = assert.rejects(
      write,
      (error) => error.delivery.stage === "outcome-unknown",
    );
    const sent = socket.sent
      .filter((event) => event.args?.[0]?.request)
      .slice(-2);
    for (const event of sent)
      socket.receive({
        type: "ipc-renderer-invoke-result",
        requestId: event.requestId,
        ok: true,
      });
    // MessagePort retirement, with no WebSocket close or failed send.
    coordinator.disconnect();
    await Promise.all([rejectedResume, rejectedWrite]);
    assert.equal(socket.readyState, 1);
    assert.equal(client.getPendingRequestCount(), 0);
    assert.equal(
      bridge.window.__ELECTRON_SHIM__.diagnostics().pendingAppRequests,
      0,
    );
    assert.equal(
      socket.sent.filter((event) => event.args?.[0]?.request).length,
      (attempt + 1) * 2,
      "writes are not replayed",
    );
    socket.view({
      type: "mcp-response",
      hostId: "local",
      message: { id: sent[0].args[0].request.id, result: { stale: true } },
    });
    assert.equal(
      client.getPendingRequestCount(),
      0,
      "late reply cannot revive the retired resume",
    );
  }
  const fresh = client.sendRequest(
    "thread/resume",
    { threadId: "fixture" },
    { timeoutMs: 0, trace: null },
  );
  const event = socket.sent.at(-1);
  socket.view({
    type: "mcp-response",
    hostId: "local",
    message: { id: event.args[0].request.id, result: { restored: true } },
  });
  assert.equal((await fresh).restored, true);
});

test("a zero-timeout native conversation resume still ends at the Web read deadline", async (t) => {
  const bridge = setup(t),
    client = await clientFor(bridge);
  const socket = bridge.sockets[0];
  socket.open();
  const resume = client.sendRequest(
    "thread/resume",
    { threadId: "fixture" },
    { timeoutMs: 0, trace: null },
  );
  const rejected = assert.rejects(resume, /read timed out/);
  socket.receive({
    type: "ipc-renderer-invoke-result",
    requestId: socket.sent[0].requestId,
    ok: true,
  });
  t.mock.timers.tick(14_999);
  assert.equal(client.getPendingRequestCount(), 1);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(client.getPendingRequestCount(), 0);
  assert.equal(
    bridge.window.__ELECTRON_SHIM__.diagnostics().pendingAppRequests,
    0,
  );
  assert.equal(
    socket.sent.filter((event) => event.args?.[0]?.request).length,
    1,
  );
});

test("failed send, failed invoke and stuck first handshake all terminate native promises", async (t) => {
  const bridge = setup(t),
    client = await clientFor(bridge);
  const first = bridge.sockets[0];
  const queued = client.sendRequest("configRequirements/read", undefined, {
    trace: null,
  });
  const rejected = assert.rejects(queued, /Connection interrupted/);
  t.mock.timers.tick(10_000);
  await rejected;
  const second = bridge.sockets.at(-1);
  second.open();
  const invoke = client.sendRequest("configRequirements/read", undefined, {
    trace: null,
  });
  const invokeRejected = assert.rejects(invoke, /Request delivery failed/);
  second.receive({
    type: "ipc-renderer-invoke-result",
    requestId: second.sent.at(-1).requestId,
    ok: false,
    errorMessage: "unavailable",
  });
  await invokeRejected;
  second.send = () => {
    throw Error("connection lost");
  };
  await assert.rejects(
    client.sendRequest("configRequirements/read", undefined, { trace: null }),
  );
  assert.equal(client.getPendingRequestCount(), 0);
});

test("foreground probes preserve healthy sockets and replace half-open sockets without stale callback damage", (t) => {
  const bridge = setup(t),
    first = bridge.sockets[0];
  first.open();
  bridge.foreground();
  bridge.pageshow();
  assert.equal(first.sent.length, 1);
  first.receive({ type: "bridge-pong", requestId: first.sent[0].requestId });
  t.mock.timers.tick(5_000);
  assert.equal(bridge.sockets.length, 1);
  bridge.foreground();
  t.mock.timers.tick(5_000);
  assert.equal(bridge.sockets.length, 2);
  const second = bridge.sockets[1];
  second.open();
  first.fire("close");
  first.fire("error");
  bridge.foreground();
  assert.equal(second.sent.at(-1).type, "bridge-ping");
});

test("reconnection replays subscriptions before recovery and suppresses duplicate host recoveries", async (t) => {
  const bridge = setup(t),
    first = bridge.sockets[0];
  first.open();
  const events = [];
  bridge.ipc.on(incoming, (_event, message) => events.push(message));
  const subscribed = bridge.ipc.invoke(channel, {
    type: "shared-object-subscribe",
    key: "remote_ssh_connections",
  });
  first.receive({
    type: "ipc-renderer-invoke-result",
    requestId: first.sent[0].requestId,
    ok: true,
  });
  await subscribed;
  for (const hostId of ["local", "remote"])
    first.view({
      type: "codex-app-server-initialized",
      hostId,
      isSnapshot: true,
    });
  first.close();
  bridge.foreground();
  const second = bridge.sockets.at(-1);
  second.open();
  assert.equal(second.sent[0].args[0].type, "shared-object-subscribe");
  assert.equal(second.sent[1].args[0].type, "ready");
  second.view({
    type: "codex-app-server-initialized",
    hostId: "local",
    isSnapshot: false,
  });
  t.mock.timers.tick(2_000);
  assert.deepEqual(
    events
      .filter((event) => event.isSnapshot === false)
      .map((event) => event.hostId),
    ["local", "remote"],
  );
});
