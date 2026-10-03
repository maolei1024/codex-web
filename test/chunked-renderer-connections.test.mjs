import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  appHostEventFactory,
  nativeChunkedRuntime,
} from "./desktop-chunked-message-harness.mjs";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { RendererConnectionHub } = await importTypescriptModule(
  "src/server/renderer-connection.ts",
);
const native = await nativeChunkedRuntime();
const channel = "codex_desktop:message-for-view";
const large = {
  type: "test-large-response",
  message: { text: "大块中文🙂".repeat(100) },
};

function setup(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const hub = new RendererConnectionHub();
  const parent = Object.assign(new EventEmitter(), {
    id: 1001,
    mainFrame: { url: "http://localhost:5175/" },
    getURL: () => "http://localhost:5175/",
    isDestroyed: () => false,
    isLoading: () => false,
    send: () => assert.fail("connection traffic fell back to shared window"),
  });
  const sender = native.createSender(hub, {
    inlineThresholdBytes: 1000,
    batchTargetBytes: 200,
  });
  const clients = [];
  function client({ beforeDeliver = () => {} } = {}) {
    const frames = [],
      preparedDeliveries = [],
      messages = [],
      failures = [];
    const receiver = new native.Reassembler();
    const connection = hub.createConnection({
      parent: () => parent,
      deliver(deliveryChannel, args, prepared) {
        beforeDeliver();
        preparedDeliveries.push(prepared);
        assert.equal(deliveryChannel, channel);
        assert.equal(args.length, 1);
        const payload = args[0];
        frames.push(payload);
        const result = receiver.receive(payload);
        if (result.type !== "pending") messages.push(result.message);
      },
      fail: (reason) => failures.push(reason),
    });
    const result = {
      connection,
      frames,
      messages,
      failures,
      receiver,
      preparedDeliveries,
    };
    clients.push(result);
    return result;
  }
  t.after(() => clients.forEach(({ connection }) => connection.close()));
  function ack(
    peer,
    part = peer.frames.findLast(
      (frame) => frame.marker === "codex-host-chunked-message-v1",
    ),
  ) {
    sender.acknowledge(peer.connection.sender, part.transferId, part.sequence);
  }
  function complete(peer) {
    let count = 0;
    for (; sender.sender.targets.get(peer.connection.sender)?.transfer; ) {
      assert.ok(++count < 200, "native chunked transfer did not finish");
      ack(peer);
    }
  }
  function advanceTo(peer, kind) {
    let count = 0;
    for (; peer.frames.at(-1).kind !== kind; ) {
      assert.ok(++count < 200);
      ack(peer);
    }
    return peer.frames.at(-1);
  }
  return { hub, parent, sender, client, ack, complete, advanceTo };
}

for (const kind of ["start", "chunk", "end"]) {
  test(`disconnect during native ${kind} releases queue and old ACK cannot reach a replacement`, (t) => {
    const env = setup(t),
      first = env.client();
    env.sender.send(first.connection.sender, channel, large);
    const part = env.advanceTo(first, kind);
    env.sender.send(first.connection.sender, channel, { type: "queued" });
    assert.equal(env.hub.diagnostics().queuedMessages, 1);
    first.connection.close();
    assert.equal(env.sender.sender.targets.size, 0);
    assert.equal(env.hub.diagnostics().pendingTransfers, 0);
    const replacement = env.client();
    env.sender.send(replacement.connection.sender, channel, large);
    const replacementPart = replacement.frames.at(-1);
    env.ack(first, part);
    env.sender.acknowledge(
      replacement.connection.sender,
      part.transferId,
      part.sequence,
    );
    assert.equal(replacement.frames.at(-1), replacementPart);
    env.complete(replacement);
    assert.deepEqual(replacement.messages, [large]);
    t.mock.timers.tick(60_000);
    assert.deepEqual(first.failures, []);
    assert.deepEqual(replacement.failures, []);
    assert.equal(env.parent.listenerCount("did-start-loading"), 0);
    assert.equal(env.parent.listenerCount("did-stop-loading"), 0);
  });

  test(`missing native ${kind} ACK closes only its connection at exactly 30 seconds`, (t) => {
    const env = setup(t),
      stalled = env.client(),
      healthy = env.client();
    env.sender.send(stalled.connection.sender, channel, large);
    env.advanceTo(stalled, kind);
    env.sender.send(stalled.connection.sender, channel, { type: "queued" });
    env.sender.send(healthy.connection.sender, channel, { type: "healthy" });
    assert.deepEqual(healthy.messages, [{ type: "healthy" }]);
    t.mock.timers.tick(29_999);
    assert.equal(stalled.connection.closed, false);
    assert.equal(env.hub.diagnostics().oldestAckWaitMs, 29_999);
    t.mock.timers.tick(1);
    assert.equal(stalled.connection.closed, true);
    assert.equal(healthy.connection.closed, false);
    assert.match(stalled.failures[0], /acknowledgement timed out/);
    assert.equal(stalled.failures.length, 1);
    assert.equal(env.hub.diagnostics().ackTimeouts, 1);
    assert.equal(env.sender.sender.targets.size, 0);
    assert.equal(env.hub.diagnostics().queuedMessages, 0);
    env.sender.send(healthy.connection.sender, channel, {
      type: "still-healthy",
    });
    assert.deepEqual(healthy.messages.at(-1), { type: "still-healthy" });
    t.mock.timers.tick(60_000);
    assert.equal(stalled.failures.length, 1);
  });
}

test("valid per-part ACKs reset deadlines and slow complete transfers have no total timeout", (t) => {
  const env = setup(t),
    peer = env.client();
  env.sender.send(peer.connection.sender, channel, large);
  let count = 0;
  for (; env.sender.sender.targets.get(peer.connection.sender)?.transfer; ) {
    assert.ok(++count < 200);
    t.mock.timers.tick(29_999);
    assert.equal(peer.connection.closed, false);
    env.ack(peer);
    assert.equal(env.hub.diagnostics().oldestAckWaitMs, 0);
  }
  assert.ok(count > 3);
  assert.ok(Date.now() > 90_000);
  assert.deepEqual(peer.messages, [large]);
  assert.deepEqual(peer.failures, []);
  assert.equal(env.hub.diagnostics().ackTimeouts, 0);
});

test("failed transport delivery starts no ACK deadline and successful native retry starts the full deadline", (t) => {
  const env = setup(t);
  let fail = true;
  const peer = env.client({
    beforeDeliver() {
      if (fail) throw new Error("transport cannot deliver yet");
    },
  });
  env.sender.send(peer.connection.sender, channel, large);
  assert.equal(peer.frames.length, 0);
  assert.equal(env.hub.diagnostics().oldestAckWaitMs, 0);
  assert.equal(env.sender.sender.targets.size, 1);
  // The actual Desktop retry timer keeps the same undelivered part.
  t.mock.timers.tick(29_000);
  assert.equal(peer.connection.closed, false);
  assert.equal(peer.frames.length, 0);
  fail = false;
  t.mock.timers.tick(1000);
  assert.equal(peer.frames.at(-1).kind, "start");
  assert.equal(env.hub.diagnostics().oldestAckWaitMs, 0);
  t.mock.timers.tick(29_999);
  assert.equal(peer.connection.closed, false);
  env.complete(peer);
  assert.deepEqual(peer.messages, [large]);
  t.mock.timers.tick(60_000);
  assert.deepEqual(peer.failures, []);
  assert.equal(env.sender.sender.targets.size, 0);
});

test("wrong, duplicate and cross-connection ACKs neither advance transfers nor extend their deadline", (t) => {
  const env = setup(t),
    a = env.client(),
    b = env.client();
  env.sender.send(a.connection.sender, channel, large);
  env.sender.send(b.connection.sender, channel, large);
  const old = a.frames.at(-1),
    other = b.frames.at(-1);
  t.mock.timers.tick(10_000);
  env.sender.acknowledge(a.connection.sender, "wrong-id", old.sequence);
  env.sender.acknowledge(a.connection.sender, old.transferId, old.sequence + 1);
  env.sender.acknowledge(a.connection.sender, other.transferId, other.sequence);
  env.sender.acknowledge(b.connection.sender, old.transferId, old.sequence);
  assert.equal(a.frames.length, 1);
  assert.equal(b.frames.length, 1);
  env.ack(a);
  const current = a.frames.at(-1);
  t.mock.timers.tick(10_000);
  env.ack(a, old);
  assert.equal(a.frames.at(-1), current);
  t.mock.timers.tick(10_000);
  assert.equal(
    b.connection.closed,
    true,
    "cross-connection ACK extended B deadline",
  );
  assert.equal(a.connection.closed, false);
  t.mock.timers.tick(9999);
  assert.equal(a.connection.closed, false);
  t.mock.timers.tick(1);
  assert.equal(a.connection.closed, true, "duplicate ACK extended A deadline");
  assert.equal(env.hub.diagnostics().ackTimeouts, 2);
});

test("ordinary, inline, critical and broadcast paths retain independent real native queues", (t) => {
  const env = setup(t),
    a = env.client(),
    b = env.client();
  assert.equal(a.connection.sender.id, b.connection.sender.id);
  env.sender.send(a.connection.sender, channel, large);
  env.sender.send(a.connection.sender, channel, { type: "ordinary-a" });
  env.sender.sendInlineMessageForView(a.connection.sender, {
    type: "inline-a",
  });
  env.sender.sendCritical(a.connection.sender, channel, { type: "critical-a" });
  assert.deepEqual(a.messages, [{ type: "critical-a" }]);
  env.sender.send(b.connection.sender, channel, { type: "ordinary-b" });
  env.sender.sendInline(b.connection.sender, channel, { type: "inline-b" });
  env.sender.sendCritical(b.connection.sender, channel, { type: "critical-b" });
  assert.deepEqual(b.messages, [
    { type: "ordinary-b" },
    { type: "inline-b" },
    { type: "critical-b" },
  ]);
  env.sender.send(env.parent, channel, { type: "shared-notification" });
  assert.deepEqual(b.messages.at(-1), { type: "shared-notification" });
  assert.equal(env.hub.diagnostics().queuedMessages, 3);
  env.complete(a);
  assert.deepEqual(a.messages, [
    { type: "critical-a" },
    large,
    { type: "ordinary-a" },
    { type: "inline-a" },
    { type: "shared-notification" },
  ]);
  assert.equal(env.sender.sender.targets.size, 0);
  assert.ok(a.preparedDeliveries.every((prepared) => prepared === true));
  assert.ok(b.preparedDeliveries.every((prepared) => prepared === true));
  b.connection.sender.send(channel, { type: "raw-electron-send" });
  assert.equal(b.preparedDeliveries.at(-1), false);
});

test("broadcast segmentation happens separately and pre-queue HTTP bypass never stalls either client", (t) => {
  const env = setup(t),
    a = env.client(),
    b = env.client();
  const calls = [];
  env.hub.configure({
    prepareGlobal(message, owner) {
      calls.push({ stage: "global", owner: owner?.id });
      return message.payload.type === "http-offload" ? null : message;
    },
    prepareConnection(connection, message) {
      calls.push({ stage: "connection", owner: connection.id });
      return message;
    },
  });
  env.sender.sendInlineMessageForView(env.parent, { type: "shared-inline" });
  assert.equal(calls.filter(({ stage }) => stage === "global").length, 1);
  assert.equal(calls.filter(({ stage }) => stage === "connection").length, 2);
  assert.deepEqual(a.messages, [{ type: "shared-inline" }]);
  assert.deepEqual(b.messages, [{ type: "shared-inline" }]);
  calls.length = 0;
  a.messages.length = 0;
  b.messages.length = 0;
  env.sender.send(env.parent, channel, large);
  assert.notEqual(a.frames.at(-1).transferId, b.frames.at(-1).transferId);
  env.complete(b);
  assert.deepEqual(b.messages, [large]);
  assert.equal(a.messages.length, 0);
  assert.equal(calls.filter(({ stage }) => stage === "global").length, 1);
  assert.equal(calls.filter(({ stage }) => stage === "connection").length, 2);
  const before = env.hub.diagnostics();
  env.sender.send(a.connection.sender, channel, { type: "http-offload" });
  assert.equal(env.hub.diagnostics().queuedMessages, before.queuedMessages);
  assert.equal(env.hub.diagnostics().pendingTransfers, before.pendingTransfers);
  a.connection.close();
  env.sender.send(env.parent, channel, { type: "after-a-close" });
  assert.deepEqual(b.messages.at(-1), { type: "after-a-close" });
});

test("native fetch handlers isolate duplicate request IDs and cancel only their owning connection", async (t) => {
  const env = setup(t),
    a = env.client(),
    b = env.client();
  const requests = new Map();
  const bridge = native.createFetchBridge(
    env.hub,
    env.sender,
    (target, _method, _body, _headers, signal) =>
      new Promise((resolve, reject) => {
        requests.set(target, { resolve, signal });
        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      }),
  );
  const request = {
    url: "vscode://codex/get-global-state",
    requestId: "same-id",
  };
  const pendingA = bridge.handleRequest(a.connection.sender, request);
  const pendingB = bridge.handleRequest(b.connection.sender, request);
  assert.equal(bridge.abortControllers.size, 2);
  bridge.cancelRequest(a.connection.sender, request);
  assert.equal(requests.get(a.connection.sender).signal.aborted, true);
  assert.equal(requests.get(b.connection.sender).signal.aborted, false);
  requests.get(b.connection.sender).resolve({ settings: "b" });
  await Promise.all([pendingA, pendingB]);
  assert.equal(bridge.abortControllers.size, 0);
  assert.equal(a.messages[0].responseType, "error");
  assert.equal(b.messages[0].responseType, "success");
  assert.deepEqual(JSON.parse(b.messages[0].bodyJsonString), { settings: "b" });
  assert.equal(a.messages.length, 1);
  assert.equal(b.messages.length, 1);
});

test("late native fetch replies for a closed connection are dropped without global broadcast", async (t) => {
  const env = setup(t),
    a = env.client(),
    b = env.client();
  let resolve;
  const bridge = native.createFetchBridge(
    env.hub,
    env.sender,
    () =>
      new Promise((release) => {
        resolve = release;
      }),
  );
  const pending = bridge.handleRequest(a.connection.sender, {
    url: "vscode://codex/get-global-state",
    requestId: "late-id",
  });
  a.connection.close();
  resolve({ text: "obsolete response" });
  await pending;
  assert.deepEqual(a.messages, []);
  assert.deepEqual(b.messages, []);
  assert.equal(env.sender.sender.targets.size, 0);
});

test("closing a connection aborts only its pending native reads and preserves running writes", async (t) => {
  const env = setup(t),
    a = env.client(),
    b = env.client();
  const operations = new Map();
  const bridge = native.createFetchBridge(
    env.hub,
    env.sender,
    (_target, method, _body, _headers, signal) =>
      new Promise((resolve, reject) => {
        operations.set(method, { resolve, signal });
        signal.addEventListener(
          "abort",
          () => reject(new Error("read disconnected")),
          { once: true },
        );
      }),
  );
  const read = bridge.handleRequest(a.connection.sender, {
    url: "vscode://codex/get-global-state",
    requestId: "read",
  });
  const write = bridge.handleRequest(a.connection.sender, {
    url: "vscode://codex/write-file",
    requestId: "write",
  });
  const healthyRead = bridge.handleRequest(b.connection.sender, {
    url: "vscode://codex/get-settings",
    requestId: "read",
  });
  assert.equal(bridge.abortControllers.size, 3);
  a.connection.close();
  assert.equal(operations.get("get-global-state").signal.aborted, true);
  assert.equal(operations.get("write-file").signal.aborted, false);
  assert.equal(operations.get("get-settings").signal.aborted, false);
  operations.get("write-file").resolve({ written: true });
  operations.get("get-settings").resolve({ theme: "dark" });
  await Promise.all([read, write, healthyRead]);
  assert.equal(bridge.abortControllers.size, 0);
  assert.deepEqual(a.messages, []);
  assert.equal(b.messages.length, 1);
  assert.deepEqual(JSON.parse(b.messages[0].bodyJsonString), { theme: "dark" });
});

test("100 disconnect/reconnect cycles release native queues and subscriptions while a peer remains usable", (t) => {
  const env = setup(t),
    healthy = env.client();
  for (let i = 0; i < 100; i++) {
    const peer = env.client();
    let subscriptions = 1;
    peer.connection.sender.once("destroyed", () => {
      subscriptions--;
    });
    env.sender.send(peer.connection.sender, channel, large);
    env.sender.send(peer.connection.sender, channel, { type: "queued", i });
    assert.equal(env.hub.diagnostics().pendingTransfers, 1);
    peer.connection.close();
    peer.connection.close();
    assert.equal(subscriptions, 0);
    assert.equal(env.sender.sender.targets.size, 0);
    assert.equal(env.hub.diagnostics().connections, 1);
    assert.equal(env.hub.diagnostics().queuedMessages, 0);
    assert.equal(env.hub.diagnostics().pendingTransfers, 0);
    assert.equal(env.parent.listenerCount("did-start-loading"), 0);
    assert.equal(env.parent.listenerCount("did-stop-loading"), 0);
    env.sender.send(healthy.connection.sender, channel, { type: "healthy", i });
  }
  assert.equal(healthy.messages.length, 100);
  t.mock.timers.tick(60_000);
  assert.deepEqual(healthy.failures, []);
  assert.equal(env.hub.diagnostics().ackTimeouts, 0);
  const diagnostics = JSON.stringify(env.hub.diagnostics());
  assert.doesNotMatch(diagnostics, /text|中文|healthy|requestId|payload/);
});

test("actual AppHost port teardown leaves its WebSocket, replacement port and other browser alive", async (t) => {
  const env = setup(t),
    a = env.client(),
    b = env.client();
  const createEvent = await appHostEventFactory(env.hub, env.parent);
  function port() {
    let closed = false;
    return Object.assign(new EventEmitter(), {
      isClosed: () => closed,
      close() {
        if (!closed) {
          closed = true;
          this.emit("close");
        }
      },
      start() {},
      postMessage() {},
    });
  }
  const oldPort = port(),
    nextPort = port(),
    otherPort = port();
  const old = createEvent([oldPort], a.connection);
  const replacement = createEvent([nextPort], a.connection);
  const other = createEvent([otherPort], b.connection);
  let oldDestroyed = 0,
    replacementDestroyed = 0,
    otherDestroyed = 0;
  old.sender.once("destroyed", () => oldDestroyed++);
  replacement.sender.once("destroyed", () => replacementDestroyed++);
  other.sender.once("destroyed", () => otherDestroyed++);
  env.sender.send(old.sender, channel, large);
  oldPort.close();
  assert.equal(old.sender.isDestroyed(), true);
  assert.equal(oldDestroyed, 1);
  assert.equal(replacementDestroyed, 0);
  assert.equal(otherDestroyed, 0);
  assert.equal(a.connection.closed, false);
  assert.equal(env.hub.diagnostics().pendingTransfers, 1);
  assert.equal(env.parent.isDestroyed(), false);
  env.sender.send(old.sender, channel, { type: "discard-closed-port" });
  assert.equal(env.hub.diagnostics().queuedMessages, 0);
  // A new MessagePort on the same authenticated socket still owns the ACK.
  const first = a.frames.at(-1);
  env.sender.acknowledge(replacement.sender, first.transferId, first.sequence);
  assert.equal(a.frames.at(-1).kind, "chunk");
  env.complete(a);
  env.sender.send(replacement.sender, channel, { type: "replacement-port" });
  env.sender.send(other.sender, channel, { type: "other-browser" });
  assert.deepEqual(a.messages.at(-1), { type: "replacement-port" });
  assert.deepEqual(b.messages.at(-1), { type: "other-browser" });
  nextPort.close();
  otherPort.close();
  assert.equal(replacementDestroyed, 1);
  assert.equal(otherDestroyed, 1);
  assert.equal(env.hub.diagnostics().connections, 2);
  assert.equal(env.hub.diagnostics().pendingTransfers, 0);
});
