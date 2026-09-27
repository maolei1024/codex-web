import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { SharedObjectSubscriptions, SHARED_OBJECT_CHANNEL } =
  await importTypescriptModule("src/browser/shared-object-subscriptions.ts");

function request(type, key = "remote_ssh_connections") {
  return {
    type: "ipc-renderer-invoke",
    channel: SHARED_OBJECT_CHANNEL,
    args: [{ type, key }],
  };
}

test("reconnect replays active subscriptions before pending changes without duplication", () => {
  const subscriptions = new SharedObjectSubscriptions();
  const first = request("shared-object-subscribe");
  subscriptions.track(first);
  assert.deepEqual(
    [...subscriptions.beforeQueued([first])],
    [],
    "first connection flushes its original request",
  );
  assert.deepEqual(
    [...subscriptions.beforeQueued([])],
    [["remote_ssh_connections", 1]],
    "a lost socket must resubscribe",
  );

  const another = request("shared-object-subscribe");
  const removed = request("shared-object-unsubscribe");
  const newKey = request("shared-object-subscribe", "host_config");
  for (const message of [another, removed, newKey])
    subscriptions.track(message);
  assert.deepEqual(
    [...subscriptions.beforeQueued([another, removed, newKey])],
    [["remote_ssh_connections", 1]],
  );
  assert.deepEqual(
    [...subscriptions.beforeQueued([])],
    [
      ["remote_ssh_connections", 1],
      ["host_config", 1],
    ],
  );
  const unmount = request("shared-object-unsubscribe");
  subscriptions.track(unmount);
  assert.deepEqual([...subscriptions.beforeQueued([unmount])].sort(), [
    ["host_config", 1],
    ["remote_ssh_connections", 1],
  ]);
  assert.deepEqual([...subscriptions.beforeQueued([])], [["host_config", 1]]);
});

test("failed connection attempts retain mounted subscriptions and release unmounted ones", () => {
  const subscriptions = new SharedObjectSubscriptions();
  subscriptions.track(request("shared-object-subscribe"));
  subscriptions.track(request("shared-object-subscribe"));
  // The transport rejects and drops pending invokes when a connection fails.
  assert.deepEqual(
    [...subscriptions.beforeQueued([])],
    [["remote_ssh_connections", 2]],
  );
  subscriptions.track(request("shared-object-unsubscribe"));
  assert.deepEqual(
    [...subscriptions.beforeQueued([])],
    [["remote_ssh_connections", 1]],
  );
  subscriptions.track(request("shared-object-unsubscribe"));
  const unmatched = request("shared-object-unsubscribe");
  subscriptions.track(unmatched);
  assert.deepEqual([...subscriptions.beforeQueued([unmatched])], []);
  subscriptions.track(request("shared-object-set", "statsig_evaluations"));
  subscriptions.track({
    ...request("shared-object-subscribe"),
    channel: "unrelated",
  });
  assert.deepEqual(
    [...subscriptions.beforeQueued([])],
    [],
    "publishing does not create a subscription",
  );
});
