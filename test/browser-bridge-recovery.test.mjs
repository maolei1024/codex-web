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
      "shared-object-http",
      "binary-read-http",
      "reconnect",
      "app-host-recovery",
      "crypto-compat",
      "connection-diagnostics",
      "diagnostic-journal",
      "diagnostic-runtime",
      "diagnostic-browser",
      "transport-recovery-window",
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
const routesSource = ts.transpileModule(
  await readFile("src/browser/routes.ts", "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

function setup(t, { pathname = "/", search = "" } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const sockets = [],
    downloads = [],
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
      pathname,
      search,
    },
    history: {},
    setTimeout,
    clearTimeout,
    navigator: { onLine: true, userAgent: "test" },
    addEventListener: (type, fn) => windowEvents.set(type, fn),
  };
  const routes = {};
  vm.runInNewContext(routesSource, {
    exports: routes,
    window,
    URLSearchParams,
  });
  const exports = {};
  const document = {
    visibilityState: "visible",
    addEventListener: (type, fn) => documentEvents.set(type, fn),
    body: { append() {} },
    createElement: () => ({ click() {}, remove() {} }),
  };
  const notices = [];
  vm.runInNewContext(shimSource, {
    exports,
    window,
    Date,
    setTimeout,
    clearTimeout,
    WebSocket: Socket,
    URLSearchParams,
    document,
    AbortSignal,
    Blob,
    URL: {
      createObjectURL(blob) {
        downloads.push(blob);
        return "blob:test";
      },
      revokeObjectURL() {},
    },
    fetch: async () => ({ status: 200 }),
    matchMedia: () => ({ matches: false }),
    console: { info() {}, error() {} },
    __CODEX_APP_VERSION__: "test",
    __CODEX_WEB_BUILD_ID__: "test",
    require: (name) =>
      (name === "./reconnect"
        ? {
            reconnectDelayMs: (attempt) =>
              modules[name].reconnectDelayMs(attempt, () => 0.5),
          }
        : modules[name]) ??
      {
        "./routes": routes,
        "./files": {
          installBrowserFileUploadBridge() {},
          isLocalFilePickerMessage: () => false,
        },
        "./mobile-viewport": { installMobileViewportGuard() {} },
        "./recovery-notice": {
          recoveryNotice(...args) {
            notices.push(args);
          },
          checkForUpdate() {},
        },
        "./notifications": {
          installBrowserNotifications: () => ({ setPreviewSound() {} }),
        },
        "./notification-settings": { mountNotificationSettings() {} },
        "./thread-cache": {
          createThreadCache: () => ({
            diagnostics: () => ({}),
            connectionChanged() {},
            authenticationFailed() {},
          }),
        },
        "./thread-cache-settings": {
          mountThreadCacheSettings() {},
          showThreadCacheSync() {},
        },
      }[name] ??
      {},
  });
  return {
    sockets,
    window,
    notices,
    downloads,
    ipc: exports.ipcRenderer,
    foreground: () => documentEvents.get("visibilitychange")(),
    hide: () => {
      document.visibilityState = "hidden";
      documentEvents.get("visibilitychange")();
    },
    show: () => {
      document.visibilityState = "visible";
      documentEvents.get("visibilitychange")();
    },
    offline: () => {
      window.navigator.onLine = false;
      windowEvents.get("offline")();
    },
    online: () => {
      window.navigator.onLine = true;
      windowEvents.get("online")();
    },
    pageshow: () => windowEvents.get("pageshow")({ persisted: true }),
  };
}

for (const encoded of [
  "client-new-thread%3Adraft",
  "client-new-thread:draft",
]) {
  test(`draft route ${encoded} becomes ready without a history request and survives recovery`, async (t) => {
    const bridge = setup(t, { pathname: `/thread/${encoded}` });
    bridge.sockets[0].open();
    const recovery = bridge.window.__ELECTRON_SHIM__.appHost;
    const notices = [];
    recovery.configure(
      () => ({
        services: Promise.resolve({
          settings: { readAll: async () => ({}) },
          startup: { whenReady: async () => {} },
        }),
        close() {},
      }),
      (state) => notices.push(state),
    );
    t.after(() => recovery.disconnect());
    const services = await recovery.start();
    await services.settings.readAll();
    await services.startup.whenReady();
    const configured = () => {
      for (const method of [
        "config/read",
        "configRequirements/read",
        "model/list",
      ])
        recovery.observeNative({ method, type: "completed" });
    };
    configured();
    assert.equal(notices.at(-1), "connected");
    assert.equal(recovery.diagnostics().stages.history, undefined);
    recovery.disconnect();
    await recovery.recover();
    configured();
    assert.equal(notices.at(-1), "connected");
    t.mock.timers.tick(120_000);
    recovery.checkDeadlines();
    assert.equal(recovery.failed, false);
    assert.equal(bridge.window.location.pathname, `/thread/${encoded}`);
  });
}

test("persisted route recovery still waits for the decoded foreground history", async (t) => {
  const bridge = setup(t, {
    pathname: "/thread/thread%2D1",
    search: "?hostId=remote-test",
  });
  const recovery = bridge.window.__ELECTRON_SHIM__.appHost;
  bridge.sockets[0].open();
  const notices = [];
  recovery.configure(
    () => ({
      services: Promise.resolve({
        settings: { readAll: async () => ({}) },
        startup: { whenReady: async () => {} },
      }),
      close() {},
    }),
    (state) => notices.push(state),
  );
  t.after(() => recovery.disconnect());
  const services = await recovery.start();
  await services.settings.readAll();
  await services.startup.whenReady();
  for (const method of ["config/read", "configRequirements/read", "model/list"])
    recovery.observeNative({
      method,
      hostId: "remote-test",
      type: "completed",
    });
  assert.notEqual(notices.at(-1), "connected");
  recovery.observeNative({
    method: "thread/read",
    hostId: "remote-test",
    params: { threadId: "other" },
    type: "completed",
  });
  assert.notEqual(notices.at(-1), "connected");
  recovery.observeNative({
    method: "thread/read",
    hostId: "remote-test",
    params: { threadId: "thread-1" },
    type: "completed",
  });
  assert.equal(notices.at(-1), "connected");
});

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
  t.mock.timers.tick(500);
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
  t.mock.timers.tick(500);
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

const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

test("background IPC and repeated probes respect the current reconnect delay", async (t) => {
  const bridge = setup(t);
  for (const delay of [500, 1_000, 2_000]) {
    bridge.sockets.at(-1).close();
    const count = bridge.sockets.length;
    for (let i = 0; i < 5; i++) {
      bridge.ipc.send("test:background", {});
      assert.equal(bridge.sockets.length, count);
      bridge.foreground();
      bridge.pageshow();
      await bridge.ipc
        .invoke(channel, {
          type: "fetch",
          url: "vscode://codex/read-file-binary",
          requestId: `binary-${count}-${i}`,
        })
        .catch(() => {});
      await bridge.ipc
        .invoke(channel, {
          type: "shared-object-set",
          key: "statsig_evaluations",
          value: {},
        })
        .catch(() => {});
    }
    assert.equal(bridge.sockets.length, count);
    t.mock.timers.tick(delay - 1);
    bridge.foreground();
    assert.equal(bridge.sockets.length, count);
    t.mock.timers.tick(1);
    assert.equal(bridge.sockets.length, count + 1);
  }
});

for (const readyState of [2, 3]) {
  test(`a socket at state ${readyState} is retired before a late close can lose its pending native calls`, async (t) => {
    const bridge = setup(t),
      client = await clientFor(bridge),
      first = bridge.sockets[0];
    first.open();
    const request = client.sendRequest("configRequirements/read", undefined, {
      trace: null,
    });
    const rejected = assert.rejects(request, /Connection interrupted/);
    first.receive({
      type: "ipc-renderer-invoke-result",
      requestId: first.sent[0].requestId,
      ok: true,
    });
    // The browser changes readyState before dispatching the close event.
    first.readyState = readyState;
    first.close = () => {};
    bridge.ipc.send("test:background", {});
    assert.equal(bridge.sockets.length, 1);
    await rejected;
    assert.equal(client.getPendingRequestCount(), 0);
    assert.equal(
      bridge.window.__ELECTRON_SHIM__.diagnostics().pendingAppRequests,
      0,
    );
    t.mock.timers.tick(500);
    const second = bridge.sockets.at(-1);
    assert.notEqual(second, first);
    second.open();
    first.fire("close");
    first.fire("error");
    bridge.foreground();
    assert.equal(second.sent.at(-1).type, "bridge-ping");
    assert.equal(
      second.sent.some((event) => event.args?.[0]?.request),
      false,
      "the retired read is never replayed by the bridge",
    );
  });
}

test("heartbeat retires an established closing socket even when its close event never arrives", (t) => {
  const bridge = setup(t),
    first = bridge.sockets[0];
  first.open();
  first.readyState = 2;
  first.close = () => {};
  t.mock.timers.tick(20_000);
  assert.equal(bridge.sockets.length, 1);
  t.mock.timers.tick(499);
  assert.equal(bridge.sockets.length, 1);
  t.mock.timers.tick(1);
  assert.equal(bridge.sockets.length, 2);
});

for (const closingBeforeEvent of [false, true]) {
  test(`synchronous disconnect cleanup respects backoff with close event delayed=${closingBeforeEvent}`, (t) => {
    const bridge = setup(t),
      first = bridge.sockets[0];
    first.open();
    let cleanups = 0;
    bridge.window.__ELECTRON_SHIM__.appHost.onDisconnected(() => {
      cleanups++;
      bridge.ipc.send("test:release-old-reference", {});
    });
    if (closingBeforeEvent) {
      first.readyState = 2;
      first.close = () => {};
      bridge.ipc.send("test:background", {});
    } else first.close();
    assert.equal(cleanups, 1);
    assert.equal(bridge.sockets.length, 1);
    assert.equal(bridge.window.__ELECTRON_SHIM__.diagnostics().sendQueue, 0);
    t.mock.timers.tick(499);
    assert.equal(bridge.sockets.length, 1);
    t.mock.timers.tick(1);
    assert.equal(bridge.sockets.length, 2);
    const second = bridge.sockets.at(-1);
    second.open();
    first.fire("close");
    assert.equal(cleanups, 1);
    assert.equal(
      second.sent.some(
        (message) => message.channel === "test:release-old-reference",
      ),
      false,
    );
  });
}

test("returning from the background while offline exposes retry without spending the recovery budget", (t) => {
  const bridge = setup(t);
  bridge.sockets[0].open();
  bridge.hide();
  bridge.offline();
  bridge.sockets[0].close();
  t.mock.timers.tick(120_000);
  bridge.show();
  assert.equal(bridge.notices.at(-1)?.[0], "waiting-network");
  const state = bridge.window.__ELECTRON_SHIM__.diagnostics();
  assert.equal(state.connection.suspended, true);
  assert.equal(state.connection.transportRemainingMs, 60_000);
  assert.equal(state.appHost.exhausted, false);
  assert.equal(bridge.sockets.length, 1);
  const retry = bridge.notices.at(-1)[2];
  retry();
  assert.equal(bridge.notices.at(-1)[0], "connecting");
  assert.equal(bridge.sockets.length, 2);
  retry();
  assert.equal(bridge.sockets.length, 2);
});

test("manual retry replaces a delayed attempt but foreground resumes its remaining backoff", (t) => {
  const bridge = setup(t);
  bridge.sockets[0].close();
  bridge.notices.at(-1)[2]();
  assert.equal(bridge.sockets.length, 2);
  bridge.sockets.at(-1).close();
  bridge.hide();
  bridge.show();
  assert.equal(bridge.sockets.length, 2);
  t.mock.timers.tick(500);
  assert.equal(bridge.sockets.length, 3, "the original backoff resumes once");
});

test("a delayed close releases an AppHost handshake before a healthy replacement resumes it", async (t) => {
  const bridge = setup(t),
    first = bridge.sockets[0],
    recovery = bridge.window.__ELECTRON_SHIM__.appHost;
  first.open();
  let sessions = 0,
    closed = 0,
    finishOld;
  recovery.configure(() => ({
    services:
      ++sessions === 1
        ? new Promise((resolve) => {
            finishOld = resolve;
          })
        : Promise.resolve({
            settings: { readAll: async () => ({ restored: true }) },
            startup: { whenReady: async () => {} },
          }),
    close: () => closed++,
  }));
  const boot = recovery.start();
  await flush();
  assert.equal(recovery.diagnostics().requiredPending, 1);
  first.readyState = 2;
  first.close = () => {};
  bridge.ipc.send("test:background", {});
  await flush();
  assert.equal(closed, 1);
  assert.equal(recovery.diagnostics().requiredPending, 0);
  assert.equal(recovery.suspended, true);
  t.mock.timers.tick(500);
  bridge.sockets.at(-1).open();
  await flush();
  t.mock.timers.tick(1_000);
  const services = await boot;
  assert.equal(sessions, 2);
  assert.equal((await services.settings.readAll()).restored, true);
  const generation = recovery.generation;
  finishOld({ settings: { readAll: async () => ({ stale: true }) } });
  first.fire("close");
  await flush();
  assert.equal(recovery.generation, generation);
  assert.equal((await services.settings.readAll()).restored, true);
});

function configureRecovery(bridge) {
  const recovery = bridge.window.__ELECTRON_SHIM__.appHost;
  let sessions = 0;
  recovery.configure(() => {
    sessions++;
    return {
      services: Promise.resolve({
        settings: { readAll: async () => ({}) },
        startup: { whenReady: async () => {} },
      }),
      close() {},
    };
  });
  return { recovery, sessions: () => sessions };
}

test("fast handshake failures wait for the network without spending application retries", async (t) => {
  const bridge = setup(t),
    { recovery, sessions } = configureRecovery(bridge);
  const boot = recovery.start();
  for (const delay of [500, 1_000, 2_000, 4_000, 8_000, 15_000]) {
    bridge.sockets.at(-1).close();
    t.mock.timers.tick(delay);
    bridge.foreground();
    await flush();
  }
  assert.equal(sessions(), 0);
  assert.equal(recovery.failed, false);
  assert.equal(recovery.diagnostics().cycle?.retries ?? 0, 0);
  bridge.sockets.at(-1).open();
  await boot;
  assert.equal(sessions(), 1);
  assert.equal(recovery.suspended, false);
});

test("network recovery is bounded and repeated manual taps own one fresh attempt", async (t) => {
  const bridge = setup(t),
    { recovery } = configureRecovery(bridge);
  t.mock.timers.tick(60_001);
  await flush();
  assert.equal(bridge.notices.at(-1)[0], "failed");
  const count = bridge.sockets.length;
  t.mock.timers.tick(120_000);
  assert.equal(bridge.sockets.length, count);
  const retry = bridge.notices.at(-1)[2];
  retry();
  retry();
  retry();
  assert.equal(bridge.sockets.length, count + 1);
  assert.equal(bridge.notices.at(-1)[0], "connecting");
  for (const delay of [500, 1_000, 2_000, 4_000, 8_000, 15_000]) {
    bridge.sockets.at(-1).close();
    t.mock.timers.tick(delay);
    bridge.foreground();
    await flush();
  }
  assert.equal(recovery.failed, false);
  assert.equal(bridge.notices.at(-1)[0], "connecting");
  bridge.sockets.at(-1).open();
  await flush();
  assert.equal(recovery.suspended, false);
});

test("sleep and offline time do not exhaust the next foreground handshake", async (t) => {
  const bridge = setup(t),
    { recovery } = configureRecovery(bridge);
  bridge.hide();
  bridge.sockets[0].close();
  t.mock.timers.tick(3_600_000);
  assert.equal(bridge.sockets.length, 1);
  assert.equal(recovery.failed, false);
  bridge.show();
  assert.equal(bridge.sockets.length, 2);
  assert.equal(bridge.notices.at(-1)[0], "connecting");
  t.mock.timers.tick(3_000);
  assert.equal(recovery.failed, false);
  bridge.offline();
  bridge.sockets.at(-1).close();
  t.mock.timers.tick(600_000);
  assert.equal(bridge.sockets.length, 2);
  assert.equal(bridge.notices.at(-1)[0], "waiting-network");
  // A false offline hint must not block an explicit attempt.
  bridge.notices.at(-1)[2]();
  assert.equal(bridge.sockets.length, 3);
  bridge.sockets.at(-1).open();
  await flush();
  assert.equal(recovery.suspended, false);
});

test("a healthy sleeping page probes afresh and ignores the pre-sleep pong", async (t) => {
  const bridge = setup(t),
    { recovery } = configureRecovery(bridge);
  const socket = bridge.sockets[0];
  socket.open();
  const services = await recovery.start();
  await services.settings.readAll();
  await services.startup.whenReady();
  for (const method of ["config/read", "configRequirements/read", "model/list"])
    recovery.observeNative({ method, type: "completed" });
  bridge.foreground();
  const oldPing = socket.sent.at(-1).requestId;
  bridge.hide();
  t.mock.timers.tick(3_600_000);
  bridge.show();
  assert.equal(bridge.sockets.length, 1);
  const newPing = socket.sent.at(-1).requestId;
  assert.notEqual(newPing, oldPing);
  socket.receive({ type: "bridge-pong", requestId: oldPing });
  t.mock.timers.tick(4_999);
  assert.equal(bridge.sockets.length, 1);
  socket.receive({ type: "bridge-pong", requestId: newPing });
  t.mock.timers.tick(1);
  assert.equal(bridge.sockets.length, 1);
  assert.equal(recovery.failed, false);
});

test("bridge exports local diagnostics synchronously while fully offline", async (t) => {
  const bridge = setup(t, {
    pathname: "/thread/private-id",
    search: "?token=private-token",
  });
  bridge.offline();
  bridge.window.__ELECTRON_SHIM__.exportDiagnostics();
  assert.equal(bridge.downloads.length, 1);
  const text = await bridge.downloads[0].text(),
    report = JSON.parse(text);
  assert.equal(report.connection.online, false);
  assert.ok(report.events.some((event) => event.type === "offline"));
  assert.ok(report.events.some((event) => event.type === "export"));
  assert.equal(report.server.status, "not-requested");
  assert.ok(!text.includes("private-id"));
  assert.ok(!text.includes("private-token"));
});

test("manual retry overrides an offline hint but still expires after its finite allowance", async (t) => {
  const bridge = setup(t);
  bridge.offline();
  bridge.notices.at(-1)[2]();
  assert.equal(bridge.sockets.length, 2);
  t.mock.timers.tick(60_001);
  await flush();
  assert.equal(bridge.notices.at(-1)[0], "failed");
  const count = bridge.sockets.length;
  t.mock.timers.tick(120_000);
  assert.equal(bridge.sockets.length, count);
});

test("a cancelled old boot cannot replace the new manual attempt's progress notice", async (t) => {
  const bridge = setup(t),
    first = bridge.sockets[0];
  first.open();
  const boot = bridge.window.__ELECTRON_SHIM__
    .configureAppHost(() => ({
      services: new Promise(() => {}),
      close() {},
    }))
    .catch(() => bridge.window.__ELECTRON_SHIM__.bootFailed(() => {}));
  await flush();
  bridge.offline();
  bridge.notices.at(-1)[2]();
  await boot;
  assert.equal(bridge.sockets.length, 2);
  assert.equal(bridge.notices.at(-1)[0], "connecting");
});

test("manual retry retires calls queued while offline even when no socket remains", async (t) => {
  const bridge = setup(t),
    client = await clientFor(bridge);
  bridge.sockets[0].open();
  bridge.offline();
  bridge.sockets[0].close();
  const write = client.sendRequest(
    "turn/start",
    {},
    { trace: null, timeoutMs: 0 },
  );
  const rejected = assert.rejects(
    write,
    (error) =>
      error.name === "AppServerRequestDeliveryError" ||
      error.name === "CodexWebTransportError",
  );
  bridge.ipc.send("test:mutation", { private: true });
  bridge.notices.at(-1)[2]();
  await rejected;
  const socket = bridge.sockets.at(-1);
  socket.open();
  await flush();
  assert.equal(
    socket.sent.some(
      (message) => message.args?.[0]?.request?.method === "turn/start",
    ),
    false,
  );
  assert.equal(
    socket.sent.some((message) => message.channel === "test:mutation"),
    false,
  );
});

// Use configureAppHost, including its production state callback. Tests calling
// AppHost.configure directly cannot exercise page readiness or the shared budget.
async function readyBridge(t, sessionFactory) {
  const bridge = setup(t);
  const shim = bridge.window.__ELECTRON_SHIM__;
  let sessions = 0;
  const base = {
    settings: { readAll: async () => ({}) },
    startup: { whenReady: async () => {} },
  };
  const first = bridge.sockets[0];
  first.open();
  const boot = shim.configureAppHost(() => {
    const index = ++sessions;
    return (
      sessionFactory?.(index, base) ?? {
        services: Promise.resolve(base),
        close() {},
      }
    );
  });
  await flush();
  const snapshot = first.sent.find(
    (x) => x.channel === "codex_desktop:get-shared-object-snapshot",
  );
  assert.ok(snapshot);
  first.receive({
    type: "ipc-renderer-invoke-result",
    requestId: snapshot.requestId,
    ok: true,
    result: {},
  });
  const services = await boot;
  await services.settings.readAll();
  await services.startup.whenReady();
  const configured = () => {
    for (const method of [
      "config/read",
      "configRequirements/read",
      "model/list",
    ])
      shim.appHost.observeNative({ method, type: "completed" });
  };
  configured();
  assert.equal(shim.diagnostics().connection.state, "connected");
  return { ...bridge, shim, services, configured, sessions: () => sessions };
}

function answerPing(socket) {
  const ping = socket.sent.findLast((x) => x.type === "bridge-ping");
  if (ping) socket.receive({ type: "bridge-pong", requestId: ping.requestId });
}

test("short tab switches preserve healthy pending work and do not flood connected diagnostics", async (t) => {
  const bridge = await readyBridge(t);
  let finish;
  const request = bridge.shim.appHost.fetchRequest(
    "vscode://codex/http-fetch",
    undefined,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await flush();
  const before = bridge.shim.diagnostics();
  assert.equal(before.appHost.pending, 1);
  const noticeCount = bridge.notices.length;
  for (let i = 0; i < 10; i++) {
    bridge.hide();
    t.mock.timers.tick(300);
    bridge.show();
    answerPing(bridge.sockets[0]);
    await flush();
  }
  const after = bridge.shim.diagnostics();
  assert.equal(bridge.sockets.length, 1);
  assert.equal(after.appHost.generation, before.appHost.generation);
  assert.equal(after.appHost.pending, 1);
  assert.ok(
    bridge.notices.slice(noticeCount).every((x) => x[0] === "connected"),
  );
  finish("same request");
  assert.equal(await request, "same request");
  for (let i = 0; i < 10; i++) await bridge.services.settings.readAll();
  bridge.shim.exportDiagnostics();
  const report = JSON.parse(await bridge.downloads.at(-1).text());
  assert.equal(
    report.events.filter(
      (x) => x.type === "recovery-state" && x.state === "connected",
    ).length,
    1,
  );
  assert.ok(
    report.diagnostics.appHost.events.every((x) => Number.isFinite(x.at)),
  );
});

test("tab switches preserve an in-flight handshake and service recovery with the same 30 second allowance", async (t) => {
  let finishServices;
  const bridge = await readyBridge(t, (index, base) => ({
    services:
      index === 1
        ? Promise.resolve(base)
        : new Promise((resolve) => {
            finishServices = () => resolve(base);
          }),
    close() {},
  }));
  bridge.sockets[0].close();
  assert.equal(
    bridge.notices.at(-1)[0],
    "connected",
    "brief recovery is quiet",
  );
  t.mock.timers.tick(500);
  const socket = bridge.sockets.at(-1);
  t.mock.timers.tick(1_500);
  assert.equal(bridge.notices.at(-1)[0], "connecting");
  const attempt = bridge.shim.diagnostics().connection.attempt;
  bridge.hide();
  t.mock.timers.tick(60_000);
  bridge.show();
  assert.equal(bridge.sockets.at(-1), socket);
  assert.equal(bridge.shim.diagnostics().connection.remainingMs, 28_000);
  socket.open();
  await flush();
  assert.equal(bridge.sessions(), 2);
  const generation = bridge.shim.appHost.generation;
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(1_000);
    bridge.hide();
    t.mock.timers.tick(320);
    bridge.show();
    answerPing(socket);
    await flush();
  }
  assert.equal(bridge.sockets.length, 2);
  assert.equal(bridge.sessions(), 2);
  assert.equal(bridge.shim.appHost.generation, generation);
  assert.equal(bridge.shim.diagnostics().connection.attempt, attempt);
  assert.equal(bridge.shim.diagnostics().connection.remainingMs, 25_000);
  finishServices();
  await flush();
  bridge.configured();
  await flush();
  assert.equal(bridge.shim.diagnostics().connection.state, "connected");
});

test("transport and session recovery share one deadline, and only a new online edge restarts expiry", async (t) => {
  const bridge = await readyBridge(t);
  bridge.sockets[0].close();
  // Spend 20 seconds on failed handshakes, then finish the transport only.
  for (let i = 0; i < 20; i++) {
    t.mock.timers.tick(1_000);
    await flush();
  }
  bridge.sockets.at(-1).open();
  await flush();
  assert.equal(bridge.shim.diagnostics().connection.remainingMs, 10_000);
  assert.notEqual(bridge.shim.diagnostics().connection.state, "connected");
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(1_000);
    answerPing(bridge.sockets.at(-1));
    await flush();
  }
  assert.equal(bridge.shim.diagnostics().connection.state, "failed");
  assert.equal(bridge.shim.appHost.failed, true);
  const count = bridge.sockets.length;
  bridge.hide();
  t.mock.timers.tick(60_000);
  bridge.show();
  bridge.online();
  assert.equal(
    bridge.sockets.length,
    count,
    "visibility and duplicate online cannot reset failure",
  );
  bridge.configured();
  await flush();
  assert.equal(
    bridge.shim.diagnostics().connection.state,
    "failed",
    "late completion cannot revive expiry",
  );
  bridge.offline();
  bridge.online();
  bridge.online();
  bridge.show();
  assert.equal(bridge.sockets.length, count + 1);
  assert.equal(bridge.shim.diagnostics().connection.remainingMs, 30_000);
  bridge.sockets.at(-1).open();
  await flush();
  bridge.configured();
  await flush();
  assert.equal(bridge.shim.diagnostics().connection.state, "connected");
});

test("a connection opened while hidden resumes AppHost exactly once on return", async (t) => {
  const bridge = await readyBridge(t);
  bridge.sockets[0].close();
  t.mock.timers.tick(500);
  bridge.hide();
  bridge.sockets.at(-1).open();
  await flush();
  assert.equal(bridge.sessions(), 1);
  bridge.show();
  answerPing(bridge.sockets.at(-1));
  await flush();
  assert.equal(bridge.sessions(), 2);
  bridge.configured();
  await flush();
  assert.equal(bridge.shim.diagnostics().connection.state, "connected");
});

test("manual takeover unlocks after ten seconds and cancels old service work once", async (t) => {
  let finishOld;
  const bridge = await readyBridge(t, (index, base) => ({
    services:
      index === 2
        ? new Promise((resolve) => {
            finishOld = () => resolve(base);
          })
        : Promise.resolve(base),
    close() {},
  }));
  bridge.sockets[0].close();
  t.mock.timers.tick(500);
  bridge.sockets.at(-1).open();
  await flush();
  t.mock.timers.tick(1_500);
  const retry = bridge.notices.at(-1)[2];
  retry();
  assert.equal(bridge.sockets.length, 2);
  t.mock.timers.tick(8_000);
  await flush();
  assert.equal(bridge.notices.at(-1)[4].retryAvailable, true);
  retry();
  retry();
  retry();
  await flush();
  assert.equal(bridge.sockets.length, 3);
  assert.equal(bridge.shim.diagnostics().connection.remainingMs, 30_000);
  bridge.sockets.at(-1).open();
  await flush();
  bridge.configured();
  await flush();
  finishOld();
  await flush();
  assert.equal(bridge.shim.diagnostics().connection.state, "connected");
  assert.equal(bridge.sessions(), 3);
});

test("online recovery never bypasses authentication failure", async (t) => {
  const bridge = await readyBridge(t);
  bridge.sockets[0].close();
  t.mock.timers.tick(500);
  bridge.sockets.at(-1).open();
  await flush();
  bridge.shim.appHost.authenticationFailed();
  const count = bridge.sockets.length;
  bridge.offline();
  bridge.online();
  bridge.hide();
  bridge.show();
  assert.equal(bridge.shim.appHost.authenticationRequired, true);
  assert.equal(bridge.sockets.length, count);
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(bridge.notices.at(-1)[1], "authentication");
});

test("offline pauses an established recovery without renewing it, while manual probing consumes its fresh allowance", async (t) => {
  const bridge = await readyBridge(t);
  bridge.sockets[0].close();
  t.mock.timers.tick(4_000);
  await flush();
  bridge.offline();
  const state = bridge.shim.diagnostics().connection;
  t.mock.timers.tick(600_000);
  bridge.hide();
  bridge.show();
  assert.equal(bridge.shim.diagnostics().connection.remainingMs, 26_000);
  bridge.online();
  assert.equal(bridge.shim.diagnostics().connection.attempt, state.attempt);
  assert.equal(bridge.shim.diagnostics().connection.remainingMs, 26_000);
  bridge.offline();
  bridge.notices.at(-1)[2]();
  assert.equal(bridge.shim.diagnostics().connection.remainingMs, 30_000);
  assert.equal(bridge.shim.diagnostics().connection.suspended, false);
  assert.equal(
    bridge.notices.at(-1)[0],
    "connecting",
    "manual progress is immediate",
  );
  for (let i = 0; i < 30; i++) {
    t.mock.timers.tick(1_000);
    await flush();
  }
  assert.equal(bridge.shim.diagnostics().connection.state, "failed");
});
