import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";
import { nativeRequestClient } from "./desktop-request-harness.mjs";

const { RpcLifecycle, isTransportFailure } = await importTypescriptModule(
  "src/browser/rpc-lifecycle.ts",
);
const channel = "codex_desktop:message-from-view";

async function setup() {
  let now = 1_000,
    invoke = 0,
    client;
  const settled = [],
    deliveries = [];
  const rpc = new RpcLifecycle(
    (event) => {
      deliveries.push(event);
      client.onDelivery(event.update);
    },
    (...args) => settled.push(args),
    () => now,
  );
  ({ client } = await nativeRequestClient(
    (type, event) => {
      rpc.track(`ipc-${++invoke}`, channel, [{ type, ...event }]);
    },
    (event) => rpc.onLifecycle(event),
  ));
  return {
    rpc,
    client,
    settled,
    deliveries,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("lost send rejects the actual native RPC and unwinds submission without changing draft", async () => {
  const { rpc, client } = await setup();
  const draft = { text: "unsent text", images: ["data:image/png;base64,test"] };
  let lock = true,
    submitted = 0;
  const request = client.sendRequest("configRequirements/read", undefined, {
    trace: null,
  });
  const submit = request
    .then(() => submitted++)
    .finally(() => {
      lock = false;
    });
  const rejected = assert.rejects(submit, isTransportFailure);
  rpc.fail("ipc-1", "Request delivery failed.");
  await rejected;
  assert.equal(lock, false);
  assert.equal(submitted, 0);
  assert.deepEqual(draft, {
    text: "unsent text",
    images: ["data:image/png;base64,test"],
  });
  assert.equal(client.getPendingRequestCount(), 0);
  assert.equal(client.inFlightRequestCount, 0);
  assert.equal(rpc.size, 0);
});

test("IPC acknowledgement does not discard a request whose business reply was lost", async () => {
  const { rpc, client, deliveries } = await setup();
  const request = client.sendRequest(
    "turn/start",
    { threadId: "thread" },
    { trace: null },
  );
  const rejected = assert.rejects(
    request,
    (error) => error.delivery.stage === "outcome-unknown",
  );
  rpc.sent("ipc-1");
  // The outer invoke can already have resolved; disconnect still rejects native RPC.
  rpc.disconnect();
  rpc.disconnect();
  await rejected;
  assert.equal(deliveries.length, 1);
  client.onResult("native-1", { turn: { id: "late" } });
  assert.equal(client.getPendingRequestCount(), 0);
  assert.equal(rpc.size, 0);
});

test("config reads expire after a frozen two-hour tab; commands have no added timeout", async () => {
  const { rpc, client, advance } = await setup();
  const config = client.sendRequest("config/read", {}, { trace: null });
  const command = client.sendRequest("command/exec", {}, { trace: null });
  const rejected = assert.rejects(config, /Configuration read timed out/);
  advance(2 * 60 * 60 * 1000);
  rpc.expire();
  await rejected;
  assert.equal(client.getPendingRequestCount(), 1);
  assert.equal(rpc.size, 1);
  client.onResult("native-2", { success: true });
  await command;
  assert.equal(
    rpc.size,
    0,
    "native terminal hook also handles replies reconstructed from chunks",
  );
});

test("native timeout and successful reply clean bridge state and shorter deadlines win", async () => {
  const { rpc, client, advance } = await setup();
  const request = client.sendRequest("configRequirements/read", undefined, {
    trace: null,
    timeoutMs: 1000,
  });
  const rejected = assert.rejects(request);
  advance(999);
  rpc.expire();
  assert.equal(rpc.size, 1);
  advance(1);
  rpc.expire();
  await rejected;
  const second = client.sendRequest("thread/list", {}, { trace: null });
  const timedOut = assert.rejects(second, /Timeout/);
  client.onTimeout("native-2");
  await timedOut;
  assert.equal(rpc.size, 0);
});

test("request IDs are isolated by host and by tab", () => {
  const events = [];
  const first = new RpcLifecycle(
    (event) => events.push(event),
    () => {},
  );
  const second = new RpcLifecycle(
    () => assert.fail("other tab must not fail"),
    () => {},
  );
  const message = (hostId) => [
    {
      type: "mcp-request",
      hostId,
      request: { id: "same", method: "thread/list" },
    },
  ];
  first.track("a", channel, message("local"));
  first.track("b", channel, message("remote"));
  second.track("a", channel, message("local"));
  first.onLifecycle({ type: "completed", hostId: "local", id: "same" });
  first.disconnect();
  assert.deepEqual(
    events.map((event) => event.hostId),
    ["remote"],
  );
  assert.equal(second.size, 1);
  second.onLifecycle({ type: "completed", hostId: "local", id: "same" });
});
