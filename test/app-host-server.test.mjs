import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter, once } from "node:events";
import { nativeAppHostRuntime } from "./desktop-app-host-harness.mjs";
import WebSocket from "ws";
const require = createRequire(import.meta.url);
const {
  startIpcBridgeServer,
  parseServerArgs,
} = require("../src/server/main.js");
const { ipcMain } = require("../src/server/electron/index.js");
const rpc = await nativeAppHostRuntime();

test("initial shared state uses the native snapshot handler without exposing other synchronous IPC", async () => {
  const channel = "codex_desktop:get-shared-object-snapshot";
  const listener = (event) => {
    event.returnValue = {
      remote_ssh_connections: [{ hostId: "remote-test" }],
      statsig_evaluations: { privatePayload: true },
    };
  };
  ipcMain.on(channel, listener);
  try {
    const bridge = globalThis.__codexElectronIpcBridge;
    assert.deepEqual(await bridge.handleRendererInvoke(channel, []), {
      remote_ssh_connections: [{ hostId: "remote-test" }],
    });
    await assert.rejects(
      bridge.handleRendererInvoke("other-sync-ipc", []),
      /No ipcMain.handle/,
    );
  } finally {
    ipcMain.off(channel, listener);
  }
  await assert.rejects(
    globalThis.__codexElectronIpcBridge.handleRendererInvoke(channel, []),
    /not ready/,
  );
});

test("channel-scoped renderer lifetimes preserve primary identity and isolate destruction", () => {
  const events = [];
  ipcMain.on("test-app-host-scopes", (event) => events.push(event));
  const a = new EventEmitter(),
    b = new EventEmitter();
  const bridge = globalThis.__codexElectronIpcBridge;
  bridge.handleRendererPostMessage("test-app-host-scopes", {}, [a]);
  bridge.handleRendererPostMessage("test-app-host-scopes", {}, [b]);
  assert.equal(events[0].sender.id, events[1].sender.id);
  assert.notEqual(
    events[0].sender.__codexWebSessionId,
    events[1].sender.__codexWebSessionId,
  );
  let first = 0,
    second = 0;
  events[0].sender.once("destroyed", () => first++);
  events[1].sender.once("destroyed", () => second++);
  a.emit("close");
  assert.equal(first, 1);
  assert.equal(second, 0);
  assert.equal(events[0].sender.isDestroyed(), true);
  assert.equal(events[1].sender.isDestroyed(), false);
  b.emit("close");
  assert.equal(second, 1);
});

test("two real RPC clients with identical port IDs remain isolated through socket close", async () => {
  const callbacks = new Set();
  const peers = [];
  class Settings extends rpc.Target {
    readAll() {
      return { values: { theme: "system" }, configuredValues: {} };
    }
    async subscribe(callback) {
      const owned = callback.dup();
      callbacks.add(owned);
      owned.onRpcBroken(() => {
        callbacks.delete(owned);
      });
      await owned("subscribed");
    }
  }
  class Host extends rpc.Target {
    get services() {
      return { settings: new Settings() };
    }
  }
  const bridge = globalThis.__codexElectronIpcBridge;
  const previous = bridge.handleRendererPostMessage;
  bridge.handleRendererPostMessage = (_channel, _message, [port]) => {
    peers.push(
      new rpc.Session(
        new rpc.BackendTransport(port),
        new Host(),
      ).getRemoteMain(),
    );
  };
  const app = await startIpcBridgeServer(
    {
      ...parseServerArgs([]),
      host: "127.0.0.1",
      port: 0,
      token: "native-test",
    },
    { launchDesktopApp: false },
  );
  const clients = [];
  const url = `ws://127.0.0.1:${app.server.address().port}/__backend/ipc?token=native-test`;
  try {
    async function client() {
      const socket = new WebSocket(url);
      await once(socket, "open");
      const { port1, port2 } = new MessageChannel();
      port2.on("message", (data) => {
        if (socket.readyState === 1)
          socket.send(
            JSON.stringify({
              type: "message-port-message",
              portId: "same-id",
              data,
            }),
          );
      });
      socket.on("message", (raw) => {
        const value = JSON.parse(raw);
        if (value.type === "message-port-message")
          port2.postMessage(value.data);
        if (value.type === "message-port-close") port2.postMessage(null);
      });
      socket.on("close", () => port2.postMessage(null));
      const main = rpc.connect(port1, {});
      socket.send(
        JSON.stringify({
          type: "ipc-renderer-post-message",
          channel: "native-test",
          message: {},
          portIds: ["same-id"],
        }),
      );
      const services = await main.services;
      const item = { socket, main, services, port1, port2 };
      clients.push(item);
      return item;
    }
    const a = await client(),
      b = await client();
    let updates = 0;
    await a.services.settings.subscribe(() => {});
    await b.services.settings.subscribe(() => {
      updates++;
    });
    assert.equal(callbacks.size, 2);
    a.socket.close();
    await once(a.socket, "close");
    for (let i = 0; i < 10; i++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(callbacks.size, 1);
    assert.equal((await b.services.settings.readAll()).values.theme, "system");
    for (const callback of callbacks) await callback("still subscribed");
    assert.equal(updates, 2);
    const diagnostic = await fetch(
      `http://127.0.0.1:${app.server.address().port}/__backend/diagnostics`,
      { headers: { Cookie: "codex_web_token=native-test" } },
    ).then((r) => r.json());
    assert.equal(diagnostic.connections, 1);
    assert.equal(diagnostic.ports, 1);
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${app.server.address().port}/__backend/diagnostics`,
        )
      ).status,
      401,
    );
  } finally {
    for (const c of clients) {
      c.main[Symbol.dispose]();
      c.socket.terminate();
      c.port1.close();
      c.port2.close();
    }
    for (const peer of peers) peer[Symbol.dispose]();
    await app.close();
    bridge.handleRendererPostMessage = previous;
  }
});

test("native view callbacks survive an old tab leaving; follower writes have one owner", async () => {
  const { registerView } = require("../src/server/startup-recovery.js");
  const client = {};
  let handlers,
    registered = 0,
    removed = 0,
    writes = 0,
    notifications = 0;
  const register = (view) => {
    handlers = view;
    registered++;
    return () => removed++;
  };
  const owner = {
    getThreadRole: async () => "owner",
    requestThreadFollower: async () => {
      writes++;
      return "result";
    },
    threadArchived: async () => notifications++,
  };
  const follower = {
    getThreadRole: async () => "follower",
    requestThreadFollower: () =>
      assert.fail("follower must not receive mutations"),
    threadArchived: async () => notifications++,
  };
  const closeA = registerView(client, owner, register);
  const closeB = registerView(client, follower, register);
  assert.equal(registered, 1);
  assert.equal(await handlers.getThreadRole({}), "owner");
  assert.equal(
    await handlers.requestThreadFollower({
      hostId: "local",
      request: { params: { conversationId: "test" } },
    }),
    "result",
  );
  assert.equal(writes, 1);
  await handlers.threadArchived({});
  assert.equal(notifications, 2);
  closeA();
  assert.equal(removed, 0);
  await handlers.threadArchived({});
  assert.equal(notifications, 3);
  assert.equal(handlers.unsupportedMutation, undefined);
  closeB();
  assert.equal(removed, 1);
  const closeC = registerView(client, owner, register);
  closeA();
  assert.equal(removed, 1);
  assert.equal(await handlers.getThreadRole({}), "owner");
  closeC();
  assert.equal(removed, 2);
});
