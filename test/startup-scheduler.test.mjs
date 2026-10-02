import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { nativeRequestClient } from "./desktop-request-harness.mjs";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { AppHostRecovery } = await importTypescriptModule(
  "src/browser/app-host-recovery.ts",
);
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise(setImmediate);
};

async function nativeScheduler() {
  const source = await readFile(
    "scratch/asar/.vite/build/bootstrap-yYZ8rgHq.js",
    "utf8",
  );
  const start = source.indexOf("var lj = 8,");
  const end = source.indexOf("var kj =", start);
  assert.ok(
    start >= 0 && end > start,
    "pinned Desktop host scheduler must exist",
  );
  const Scheduler = vm.runInNewContext(`${source.slice(start, end)}; Ej`, {
    Date,
    setTimeout,
    clearTimeout,
  });
  return new Scheduler();
}

test("actual native startup reads use reserved host capacity when all ordinary slots are occupied", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const scheduler = await nativeScheduler();
  t.after(() => scheduler.clear());
  for (let i = 0; i < 5; i++)
    scheduler.enqueue({
      requestId: `busy-${i}`,
      method: "fs/readFile",
      params: { path: `fixture-${i}` },
      scheduling: { priority: "interactive" },
      dispatch() {},
      reject: () => assert.fail("fixture must occupy an ordinary slot"),
    });
  let ordinaryRan = false;
  scheduler.enqueue({
    requestId: "ordinary",
    method: "model/list",
    params: {},
    scheduling: { priority: "background" },
    dispatch: () => {
      ordinaryRan = true;
    },
    reject() {},
  });
  assert.equal(ordinaryRan, false);
  const coordinator = new AppHostRecovery();
  const priorities = [];
  const { client } = await nativeRequestClient(
    (type, data) => {
      if (type !== "mcp-request") return;
      const request = data.request;
      priorities.push(data.priority);
      scheduler.enqueue({
        requestId: request.id,
        method: request.method,
        params: request.params,
        scheduling: data,
        dispatch() {
          queueMicrotask(() => {
            scheduler.complete(request.id);
            client.onResult(request.id, { ok: true });
          });
        },
        reject: () => assert.fail("startup must use the reserved slot"),
      });
    },
    (event) => coordinator.observeNative(event),
    coordinator,
  );
  client.useHostRequestScheduler = true;
  const reads = [
    "config/read",
    "configRequirements/read",
    "model/list",
    "thread/read",
  ];
  const results = await Promise.all(
    reads.map((method) =>
      client.sendRequest(method, {}, { priority: "background" }),
    ),
  );
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(
    priorities,
    reads.map(() => "critical"),
  );
  assert.equal(
    ordinaryRan,
    false,
    "background work is not promoted or cancelled",
  );
  assert.equal(client.requestPromises.size, 0);
});

test("native queued read expiration retries twice with the shared deadline and settles the client", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const coordinator = new AppHostRecovery();
  let calls = 0;
  const { client } = await nativeRequestClient(
    (type, data) => {
      if (type !== "mcp-request") return;
      calls++;
      queueMicrotask(() =>
        client.onError(data.request.id, {
          code: -32001,
          message: "App server request expired while queued",
        }),
      );
    },
    (event) => coordinator.observeNative(event),
    coordinator,
  );
  const result = assert.rejects(
    client.sendRequest("configRequirements/read", {}),
  );
  await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(999);
  await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(calls, 2);
  t.mock.timers.tick(2999);
  await settle();
  assert.equal(calls, 2);
  t.mock.timers.tick(1);
  await settle();
  await result;
  assert.equal(calls, 3);
  assert.equal(coordinator.failed, true);
  assert.equal(client.requestPromises.size, 0);
});

test("queued startup read succeeds after a retry; application failures and writes never replay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  for (const kind of ["recover", "permission", "write"]) {
    const coordinator = new AppHostRecovery();
    let calls = 0;
    const priorities = [];
    const { client } = await nativeRequestClient(
      (type, data) => {
        if (type !== "mcp-request") return;
        calls++;
        priorities.push(data.priority);
        queueMicrotask(() => {
          if (calls > 1 && kind === "recover")
            client.onResult(data.request.id, { restored: true });
          else
            client.onError(data.request.id, {
              code: kind === "permission" ? -32603 : -32001,
              message:
                kind === "permission"
                  ? "Permission denied"
                  : "App server request queue is full",
            });
        });
      },
      (event) => coordinator.observeNative(event),
      coordinator,
    );
    const request = client.sendRequest(
      kind === "write" ? "turn/start" : "config/read",
      {},
      { priority: "interactive", trace: null },
    );
    const result = kind === "recover" ? request : assert.rejects(request);
    await settle();
    t.mock.timers.tick(1000);
    await settle();
    if (kind === "recover") assert.equal((await result).restored, true);
    else await result;
    assert.equal(calls, kind === "recover" ? 2 : 1);
    if (kind === "write") assert.deepEqual(priorities, ["interactive"]);
    assert.equal(client.requestPromises.size, 0);
  }
});
