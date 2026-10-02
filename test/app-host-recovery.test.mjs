import test from "node:test";
import assert from "node:assert/strict";
import { nativeAppHostRuntime } from "./desktop-app-host-harness.mjs";
import { importTypescriptModule } from "./import-typescript-module.mjs";
const { AppHostRecovery } = await importTypescriptModule(
  "src/browser/app-host-recovery.ts",
);
const rpc = await nativeAppHostRuntime();
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  for (let i = 0; i < 12; i++) await tick();
}
function setup(
  t,
  read = async () => ({ values: { theme: "system" }, configuredValues: {} }),
  { requiresHistory, activeScope } = {},
) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const channels = [],
    peers = [],
    callbacks = new Set();
  let writes = 0,
    connections = 0;
  class Settings extends rpc.Target {
    readAll() {
      return read();
    }
    write() {
      writes++;
      return new Promise(() => {});
    }
    async subscribe(_key, callback) {
      callbacks.add(callback);
      callback.onRpcBroken(() => callbacks.delete(callback));
      await callback("initial");
      return new (class extends rpc.Target {
        [Symbol.dispose]() {
          callbacks.delete(callback);
        }
      })();
    }
  }
  const settings = new Settings();
  class FolderConsent extends rpc.Target {
    async subscribe(callback) {
      callbacks.add(callback);
      callback.onRpcBroken(() => callbacks.delete(callback));
      await callback("initial consent");
      return new (class extends rpc.Target {
        unsubscribe() {
          callbacks.delete(callback);
        }
      })();
    }
  }
  class Host extends rpc.Target {
    get services() {
      return {
        settings,
        accessInputs: settings,
        projectFolderConsent: new FolderConsent(),
        startup: new (class extends rpc.Target {
          whenReady() {}
        })(),
      };
    }
  }
  const coordinator = new AppHostRecovery(
    Date.now,
    requiresHistory,
    activeScope,
  );
  coordinator.configure(() => {
    connections++;
    const { port1, port2 } = new MessageChannel();
    channels.push(port1, port2);
    const peer = rpc.connect(port2, new Host());
    const host = rpc.connect(port1, {});
    peers.push(peer, host);
    return { services: host.services, close: () => host[Symbol.dispose]() };
  });
  t.after(() => {
    coordinator.disconnect();
    for (const peer of peers) peer[Symbol.dispose]();
    for (const port of channels) port.close();
  });
  return {
    coordinator,
    callbacks,
    channels,
    get writes() {
      return writes;
    },
    get connections() {
      return connections;
    },
  };
}

test("native MessagePort close sentinel rejects an outstanding services handshake", async () => {
  const { port1, port2 } = new MessageChannel();
  const host = rpc.connect(port1, {});
  const wait = Promise.resolve(host.services);
  const rejected = assert.rejects(wait, /closed MessagePort/);
  port2.postMessage(null);
  await rejected;
  host[Symbol.dispose]();
  port1.close();
  port2.close();
});

test("Desktop account subscriptions retain RPC broken notifications before and after resolution", async (t) => {
  const env = setup(t);
  const services = await env.coordinator.start();
  const updates = [],
    failures = [];
  const request = services.accessInputs.subscribe("account", (value) =>
    updates.push(value),
  );
  request.onRpcBroken((error) => failures.push(error));
  const subscription = await request;
  subscription.onRpcBroken((error) => failures.push(error));
  assert.deepEqual(updates, ["initial"]);
  assert.equal(env.callbacks.size, 1);
  subscription[Symbol.dispose]();
  await settle();
  assert.equal(env.callbacks.size, 0);
  assert.deepEqual(failures, []);
});

test("Desktop folder consent supports synchronous effect cleanup before and after RPC resolution", async (t) => {
  const env = setup(t);
  const services = await env.coordinator.start();
  const early = services.projectFolderConsent.subscribe(() => {});
  early.unsubscribe();
  early[Symbol.dispose]();
  await early;
  await settle();
  assert.equal(env.callbacks.size, 0);
  assert.equal(env.coordinator.diagnostics().subscriptions, 0);
  const updates = [];
  const live = services.projectFolderConsent.subscribe((value) =>
    updates.push(value),
  );
  await live;
  assert.deepEqual(updates, ["initial consent"]);
  env.coordinator.disconnect();
  await env.coordinator.recover();
  await settle();
  assert.equal(env.callbacks.size, 1);
  assert.deepEqual(updates, ["initial consent", "initial consent"]);
  live.unsubscribe();
  live[Symbol.dispose]();
  await settle();
  assert.equal(env.callbacks.size, 0);
  assert.equal(env.coordinator.diagnostics().subscriptions, 0);
});

test("settings that never reply stop after two retries and clean the real native RPC", async (t) => {
  const env = setup(t, () => new Promise(() => {}));
  const services = await env.coordinator.start();
  const request = services.settings.readAll();
  const rejected = assert.rejects(request, /超时|中断/);
  await settle();
  for (const advance of [15_000, 1_000, 15_000, 3_000, 15_000]) {
    t.mock.timers.tick(advance);
    await settle();
  }
  await rejected;
  assert.equal(env.connections, 3);
  assert.equal(env.coordinator.diagnostics().pending, 0);
  assert.equal(env.coordinator.diagnostics().exhausted, true);
});

test("an RPC deadline while the WebSocket is healthy requests full startup recovery", async (t) => {
  let blocked = false,
    notifications = 0;
  const env = setup(t, () =>
    blocked ? new Promise(() => {}) : { values: {}, configuredValues: {} },
  );
  // Use the same recovery callback as the browser, keeping the real pinned RPC.
  const factory = env.coordinator.factory;
  let recovering;
  env.coordinator.configure(factory, undefined, () => {
    if (recovering) return;
    notifications++;
    blocked = false;
    recovering = env.coordinator.recover().then(() => {
      for (const method of [
        "config/read",
        "configRequirements/read",
        "model/list",
      ])
        env.coordinator.observeNative({
          method,
          hostId: "local",
          type: "completed",
        });
    });
  });
  const services = await env.coordinator.start();
  await services.settings.readAll();
  await services.startup.whenReady();
  for (const method of ["config/read", "configRequirements/read", "model/list"])
    env.coordinator.observeNative({
      method,
      hostId: "local",
      type: "completed",
    });
  blocked = true;
  const read = services.settings.readAll();
  await settle();
  t.mock.timers.tick(15_000);
  await settle();
  t.mock.timers.tick(1_000);
  await settle();
  await read;
  await recovering;
  assert.equal(notifications, 1);
  assert.equal(env.connections, 2);
  assert.equal(env.coordinator.initialSettings, true);
  assert.equal(env.coordinator.initialStartup, true);
  t.mock.timers.tick(61_000);
  env.coordinator.checkDeadlines();
  assert.equal(env.coordinator.failed, false);
});

test("cancelling obsolete startup fetches rejects their callers without failing the page", async (t) => {
  const env = setup(t);
  const services = await env.coordinator.start();
  const controller = new AbortController();
  const read = env.coordinator.fetchRequest(
    "vscode://codex/get-global-state",
    controller.signal,
    (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const cancelled = assert.rejects(read, { name: "AbortError" });
  await settle();
  controller.abort();
  await cancelled;
  await assert.rejects(
    env.coordinator.fetchRequest(
      "vscode://codex/codex-home",
      controller.signal,
      async () => assert.fail("cancelled read dispatched"),
    ),
    { name: "AbortError" },
  );
  await services.settings.readAll();
  await services.startup.whenReady();
  for (const method of ["config/read", "configRequirements/read", "model/list"])
    env.coordinator.observeNative({
      method,
      hostId: "local",
      type: "completed",
    });
  t.mock.timers.tick(61_000);
  env.coordinator.checkDeadlines();
  assert.equal(env.coordinator.failed, false);
  assert.equal(env.coordinator.diagnostics().pending, 0);
});

test("three reconnections replace native references, restore subscriptions, and never replay writes", async (t) => {
  const env = setup(t);
  const services = await env.coordinator.start();
  let updates = 0;
  const subscription = await services.settings.subscribe("theme", () => {
    updates++;
  });
  for (let i = 0; i < 3; i++) {
    const write = services.settings.write("theme", "dark");
    const rejected = assert.rejects(write, /中断/);
    await settle();
    env.coordinator.disconnect();
    await rejected;
    await env.coordinator.recover();
    await settle();
    assert.deepEqual(await services.settings.readAll(), {
      values: { theme: "system" },
      configuredValues: {},
    });
    assert.equal(env.callbacks.size, 1);
    assert.equal(env.coordinator.diagnostics().pending, 0);
  }
  assert.equal(env.writes, 3);
  assert.equal(updates, 4);
  subscription[Symbol.dispose]();
  await settle();
  assert.equal(env.coordinator.diagnostics().subscriptions, 0);
});

test("late reply from an expired generation cannot update a newer read", async (t) => {
  let release,
    count = 0;
  const env = setup(t, () =>
    ++count === 1
      ? new Promise((resolve) => {
          release = resolve;
        })
      : Promise.resolve({ values: { theme: "new" } }),
  );
  const services = await env.coordinator.start();
  const request = services.settings.readAll();
  await settle();
  t.mock.timers.tick(15_000);
  await settle();
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal((await request).values.theme, "new");
  release({ values: { theme: "old" } });
  await settle();
  assert.equal((await services.settings.readAll()).values.theme, "new");
  assert.equal(env.coordinator.diagnostics().pending, 0);
});

test("foreground deadline check honors elapsed time rather than suspended timer delays", async (t) => {
  const env = setup(t, () => new Promise(() => {}));
  const services = await env.coordinator.start();
  const request = services.settings.readAll();
  const rejected = assert.rejects(request);
  await settle();
  t.mock.timers.setTime(65_000);
  env.coordinator.checkDeadlines();
  await settle();
  await rejected;
  assert.equal(env.connections, 1);
  assert.equal(env.coordinator.diagnostics().pending, 0);
});

test("concurrent settings failures share retry rounds and successful reads do not reset their budget", async (t) => {
  const env = setup(t, () => new Promise(() => {}));
  const services = await env.coordinator.start();
  const a = assert.rejects(services.settings.readAll());
  const b = assert.rejects(services.settings.readAll());
  await settle();
  for (const advance of [15_000, 1_000, 15_000, 3_000, 15_000]) {
    t.mock.timers.tick(advance);
    await settle();
  }
  await Promise.all([a, b]);
  assert.equal(env.connections, 3);
  assert.equal(env.coordinator.diagnostics().pending, 0);
});

test("required configuration failure cannot be hidden by successful display settings", async (t) => {
  const env = setup(t);
  const services = await env.coordinator.start();
  env.coordinator.observeNative({
    method: "configRequirements/read",
    type: "failed",
  });
  await services.settings.readAll();
  await services.startup.whenReady();
  assert.equal(
    env.coordinator.diagnostics().stages.requirements.state,
    "failed",
  );
  t.mock.timers.setTime(62_000);
  env.coordinator.checkDeadlines();
  assert.equal(env.coordinator.failed, true);
});

test("lazy asset download time does not consume the foreground configuration deadline", async (t) => {
  let release;
  const env = setup(
    t,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const services = await env.coordinator.start();
  const read = services.settings.readAll();
  await settle();
  t.mock.timers.tick(10_000);
  release({ values: {}, configuredValues: {} });
  await read;
  await services.startup.whenReady();
  // The handshake is complete but the module issuing model/config reads has
  // not downloaded yet. There is no outstanding RPC to time out.
  t.mock.timers.tick(180_000);
  env.coordinator.checkDeadlines();
  assert.equal(env.coordinator.failed, false);
  assert.equal(env.coordinator.everReady, false);
  env.coordinator.observeNative({
    method: "config/read",
    hostId: "local",
    type: "started",
  });
  t.mock.timers.tick(49_000);
  env.coordinator.checkDeadlines();
  assert.equal(env.coordinator.failed, false);
  t.mock.timers.tick(1_000);
  env.coordinator.checkDeadlines();
  assert.equal(
    env.coordinator.failed,
    true,
    "actual configuration retains the remaining budget, not a fresh deadline",
  );
});

test("a startup fetch during the lazy module gap resumes the bounded budget", async (t) => {
  const env = setup(t);
  const services = await env.coordinator.start();
  await services.settings.readAll();
  await services.startup.whenReady();
  t.mock.timers.tick(180_000);
  const read = env.coordinator.fetchRequest(
    "vscode://codex/get-shared-object-snapshot",
    undefined,
    () => new Promise(() => {}),
  );
  const rejected = assert.rejects(read);
  await settle();
  t.mock.timers.setTime(Date.now() + 61_000);
  env.coordinator.checkDeadlines();
  await rejected;
  assert.equal(env.coordinator.failed, true);
  assert.equal(env.coordinator.diagnostics().pending, 0);
});

test("unrelated native RPC and background HTTP cannot keep a configured page in startup", async (t) => {
  const env = setup(t);
  const services = await env.coordinator.start();
  const native = services.settings.write("theme", "dark");
  const nativeEnded = assert.rejects(native);
  const http = env.coordinator.fetchRequest(
    "/background",
    undefined,
    () => new Promise(() => {}),
  );
  const httpEnded = assert.rejects(http);
  await settle();
  await services.settings.readAll();
  await services.startup.whenReady();
  for (const method of ["config/read", "configRequirements/read", "model/list"])
    env.coordinator.observeNative({ method, type: "completed" });
  await settle();
  assert.equal(env.coordinator.diagnostics().pending, 2);
  assert.equal(env.coordinator.diagnostics().requiredPending, 0);
  t.mock.timers.tick(61_000);
  env.coordinator.checkDeadlines();
  assert.equal(env.coordinator.failed, false);
  env.coordinator.disconnect();
  await Promise.all([nativeEnded, httpEnded]);
  assert.equal(env.writes, 1);
});

test("idle reads and subscriptions never arm a new startup deadline or inherit background failures", async (t) => {
  let applicationError = false;
  const env = setup(t, async () => {
    if (applicationError) throw new Error("read denied");
    return { values: {} };
  });
  const services = await env.coordinator.start();
  await services.settings.readAll();
  await services.startup.whenReady();
  for (const method of ["config/read", "configRequirements/read", "model/list"])
    env.coordinator.observeNative({ method, type: "completed" });
  await settle();

  const background = env.coordinator.fetchRequest(
    "/background",
    undefined,
    () => new Promise(() => {}),
  );
  const backgroundEnded = assert.rejects(background);
  // A background read of an unmaterialized thread is an application error,
  // not evidence that the current conversation lost its required settings.
  env.coordinator.observeNative({ method: "thread/read", type: "started" });
  env.coordinator.observeNative({ method: "thread/read", type: "failed" });
  await services.settings.readAll();
  const subscription = await services.settings.subscribe("theme", () => {});
  await env.coordinator.fetchRequest(
    "vscode://codex/get-host-config",
    undefined,
    async () => ({ id: "local" }),
  );
  applicationError = true;
  await assert.rejects(services.settings.readAll(), /read denied/);
  t.mock.timers.tick(120_000);
  env.coordinator.checkDeadlines();
  await settle();
  assert.equal(env.coordinator.failed, false);
  assert.equal(env.connections, 1);
  assert.equal(env.callbacks.size, 1);
  assert.equal(env.coordinator.diagnostics().stages.history, undefined);
  assert.equal(env.coordinator.diagnostics().pending, 1);
  subscription[Symbol.dispose]();
  env.coordinator.disconnect();
  await backgroundEnded;
});

test("an actual read timeout after readiness still gets only two recovery retries", async (t) => {
  let hang = false;
  const env = setup(t, () =>
    hang ? new Promise(() => {}) : Promise.resolve({}),
  );
  const services = await env.coordinator.start();
  await services.settings.readAll();
  await services.startup.whenReady();
  for (const method of ["config/read", "configRequirements/read", "model/list"])
    env.coordinator.observeNative({ method, type: "completed" });
  await settle();
  hang = true;
  const rejected = assert.rejects(services.settings.readAll(), /超时|中断/);
  await settle();
  for (const advance of [15_000, 1_000, 15_000, 3_000, 15_000]) {
    t.mock.timers.tick(advance);
    await settle();
  }
  await rejected;
  assert.equal(env.connections, 3);
  assert.equal(env.coordinator.failed, true);
  assert.equal(env.coordinator.diagnostics().pending, 0);
});

test("startup native reads retry the extracted request client, while ready write preparation does not replay", async (t) => {
  const { nativeRequestClient } = await import("./desktop-request-harness.mjs");
  const env = setup(t);
  const services = await env.coordinator.start();
  await services.settings.readAll();
  await services.startup.whenReady();
  let count = 0;
  const { client } = await nativeRequestClient(
    (_type, { request }) => {
      count++;
      queueMicrotask(() => {
        if (count === 1)
          client.onDelivery({
            type: "failed",
            delivery: {
              requestId: request.id,
              method: request.method,
              stage: "not-sent",
            },
            message: "test disconnection",
          });
        else client.onResult(request.id, { config: {} });
      });
    },
    (e) => env.coordinator.observeNative(e),
    env.coordinator,
  );
  const result = client.sendRequest("config/read", {}, { trace: null });
  await settle();
  t.mock.timers.tick(1_000);
  await settle();
  assert.deepEqual(await result, { config: {} });
  assert.equal(count, 2);
  env.coordinator.observeNative({
    method: "configRequirements/read",
    type: "completed",
  });
  env.coordinator.observeNative({ method: "model/list", type: "completed" });
  const attempts = count;
  const failure = env.coordinator.nativeRequest("config/read", async () => {
    count++;
    const e = new Error("stop pending send");
    e.name = "AppServerRequestDeliveryError";
    throw e;
  });
  await assert.rejects(failure, /stop pending send/);
  assert.equal(count, attempts + 1);
});

test("optional durable authentication errors do not exhaust local startup recovery", async (t) => {
  const env = setup(t);
  const services = await env.coordinator.start();
  await services.settings.readAll();
  await services.startup.whenReady();
  const { Client } = await import("./desktop-request-harness.mjs").then(
    ({ nativeRequestClient }) =>
      nativeRequestClient(
        () => {},
        (event) => env.coordinator.observeNative(event),
        env.coordinator,
      ),
  );
  let requests = 0;
  const cloud = new Client("durable", (_type, { request }) => {
    requests++;
    queueMicrotask(() =>
      cloud.onError(request.id, {
        code: -32000,
        message: "Sign in to ChatGPT",
      }),
    );
  });
  await assert.rejects(cloud.sendRequest("thread/list", {}, { trace: null }), {
    message: "Sign in to ChatGPT",
  });
  assert.equal(requests, 1);
  for (const method of ["config/read", "configRequirements/read", "model/list"])
    env.coordinator.observeNative({
      method,
      hostId: "local",
      type: "completed",
    });
  await settle();
  assert.equal(env.coordinator.diagnostics().exhausted, false);
  assert.equal(env.coordinator.diagnostics().stages.models.state, "completed");
});

test("disconnect before dispatch cannot turn a rejected write into a late mutation", async (t) => {
  const env = setup(t);
  const services = await env.coordinator.start();
  const write = services.settings.write("theme", "dark");
  const rejected = assert.rejects(write);
  env.coordinator.disconnect();
  await rejected;
  await settle();
  assert.equal(env.writes, 0);
  assert.equal(services.nonexistentService, undefined);
});

test("background SSH and sidebar history failures cannot exhaust home startup or reconnection", async (t) => {
  const env = setup(t);
  const services = await env.coordinator.start();
  const { Client } = await import("./desktop-request-harness.mjs").then(
    ({ nativeRequestClient }) =>
      nativeRequestClient(
        () => {},
        (event) => env.coordinator.observeNative(event),
        env.coordinator,
      ),
  );
  const clients = ["local", "remote-ssh-offline"].map((host) => {
    const client = new Client(host, (_type, { request }) => {
      queueMicrotask(() =>
        client.onError(request.id, {
          code: -32000,
          message: "Background history unavailable",
        }),
      );
    });
    return client;
  });
  for (const reconnect of [false, true]) {
    if (reconnect) {
      env.coordinator.disconnect();
      await env.coordinator.recover();
    }
    for (const client of clients)
      await assert.rejects(
        client.sendRequest(
          "thread/read",
          { threadId: "old-sidebar-thread" },
          { trace: null },
        ),
        { message: "Background history unavailable" },
      );
    for (const hostId of ["remote-ssh-offline", "durable"])
      await assert.rejects(
        env.coordinator.fetchRequest(
          "vscode://codex/codex-home",
          undefined,
          async () => {
            throw new Error("Background home unavailable");
          },
          JSON.stringify({ hostId }),
        ),
        /Background home unavailable/,
      );
    await assert.rejects(
      clients[1].sendRequest("config/read", {}, { trace: null }),
      { message: "Background history unavailable" },
    );
    await services.settings.readAll();
    await services.startup.whenReady();
    for (const method of [
      "config/read",
      "configRequirements/read",
      "model/list",
    ])
      env.coordinator.observeNative({
        method,
        hostId: "local",
        type: "completed",
      });
    await settle();
    t.mock.timers.tick(61_000);
    env.coordinator.checkDeadlines();
    assert.equal(env.coordinator.failed, false);
    assert.deepEqual(env.coordinator.diagnostics().requiredFailures, []);
    assert.equal(env.coordinator.diagnostics().stages.history, undefined);
  }
});

test("selected host fetch failures still block startup", async (t) => {
  const env = setup(t, undefined, {
    activeScope: () => ({ hostId: "remote-ssh-selected" }),
  });
  await env.coordinator.start();
  await assert.rejects(
    env.coordinator.fetchRequest(
      "vscode://codex/codex-home",
      undefined,
      async () => {
        throw new Error("Selected home unavailable");
      },
      JSON.stringify({ hostId: "remote-ssh-selected" }),
    ),
    /Selected home unavailable/,
  );
  assert.equal(env.coordinator.failed, true);
});

test("foreground SSH recovery requires that host and conversation, not other hosts or sidebar reads", async (t) => {
  const env = setup(t, undefined, {
    requiresHistory: () => true,
    activeScope: () => ({
      hostId: "remote-ssh-selected",
      threadId: "foreground",
    }),
  });
  const services = await env.coordinator.start();
  await services.settings.readAll();
  await services.startup.whenReady();
  for (const method of ["config/read", "configRequirements/read", "model/list"])
    env.coordinator.observeNative({
      method,
      hostId: "local",
      type: "completed",
    });
  assert.equal(env.coordinator.diagnostics().stages.models, undefined);
  const hostId = "remote-ssh-selected";
  for (const method of ["config/read", "configRequirements/read", "model/list"])
    env.coordinator.observeNative({ method, hostId, type: "completed" });
  env.coordinator.observeNative({
    hostId,
    method: "thread/read",
    id: "background",
    params: { threadId: "sidebar" },
    type: "started",
  });
  env.coordinator.observeNative({
    hostId,
    method: "thread/read",
    id: "background",
    type: "failed",
  });
  assert.equal(env.coordinator.diagnostics().stages.history, undefined);
  assert.deepEqual(env.coordinator.diagnostics().requiredFailures, []);
  env.coordinator.observeNative({
    hostId,
    method: "thread/resume",
    id: "active",
    params: { threadId: "foreground" },
    type: "started",
  });
  env.coordinator.observeNative({
    hostId,
    method: "thread/resume",
    id: "active",
    type: "failed",
  });
  assert.deepEqual(env.coordinator.diagnostics().requiredFailures, [
    `${hostId}:thread/resume`,
  ]);
  env.coordinator.observeNative({
    hostId,
    method: "thread/resume",
    id: "retry",
    params: { threadId: "foreground" },
    type: "started",
  });
  env.coordinator.observeNative({
    hostId,
    method: "thread/resume",
    id: "retry",
    type: "completed",
  });
  await settle();
  t.mock.timers.tick(61_000);
  env.coordinator.checkDeadlines();
  assert.equal(env.coordinator.failed, false);
  assert.equal(env.coordinator.diagnostics().stages.history.state, "completed");
});
