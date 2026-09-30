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
  class Host extends rpc.Target {
    get services() {
      return {
        settings,
        startup: new (class extends rpc.Target {
          whenReady() {}
        })(),
      };
    }
  }
  const coordinator = new AppHostRecovery();
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
