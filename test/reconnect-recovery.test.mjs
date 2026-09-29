import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { ReconnectRecovery } = await importTypescriptModule(
  "src/browser/reconnect-recovery.ts",
);
const { ConnectionWatchdog } = await importTypescriptModule(
  "src/browser/connection-watchdog.ts",
);
const initialized = (hostId, isSnapshot = true) => ({
  type: "codex-app-server-initialized",
  hostId,
  isSnapshot,
});

test("reconnect converts snapshots into recovery events for local and remote hosts once", () => {
  const recovery = new ReconnectRecovery();
  const snapshot = initialized("local");
  recovery.observe(snapshot);
  recovery.observe(initialized("remote"));
  recovery.begin();
  assert.deepEqual(
    recovery.pending().map((event) => [event.hostId, event.isSnapshot]),
    [
      ["local", false],
      ["remote", false],
    ],
  );
  assert.equal(snapshot.isSnapshot, true);
  assert.deepEqual(recovery.pending(), []);
});

test("fresh real initialization supersedes replay; disconnected remote waits until connected", () => {
  const recovery = new ReconnectRecovery();
  recovery.observe(initialized("local"));
  recovery.observe(initialized("remote"));
  recovery.begin();
  recovery.observe(initialized("local", false));
  recovery.observe({
    type: "codex-app-server-connection-changed",
    hostId: "remote",
    state: "disconnected",
  });
  assert.deepEqual(recovery.pending(), []);
  recovery.observe({
    type: "codex-app-server-connection-changed",
    hostId: "remote",
    state: "connected",
  });
  assert.equal(recovery.pending()[0].hostId, "remote");
});

test("foreground probes coalesce and a matching pong preserves the healthy connection", () => {
  let now = 0,
    failures = 0,
    sent = 0;
  const watchdog = new ConnectionWatchdog(
    () => failures++,
    () => now,
  );
  watchdog.opened();
  watchdog.probe("one", () => sent++);
  watchdog.probe("two", () => sent++);
  watchdog.pong("stale");
  assert.equal(sent, 1);
  watchdog.pong("one");
  now += 2 * 60 * 60 * 1000;
  assert.equal(watchdog.check(), true);
  assert.equal(failures, 0);
  watchdog.stop();
});

test("wall-clock checks bound a stuck handshake and a frozen half-open connection", () => {
  let now = 0,
    failures = 0;
  const watchdog = new ConnectionWatchdog(
    () => failures++,
    () => now,
  );
  now = 10_000;
  assert.equal(watchdog.check(), false);
  assert.equal(failures, 1);
  watchdog.opened();
  watchdog.probe("one", () => {});
  now += 2 * 60 * 60 * 1000;
  assert.equal(watchdog.check(), false);
  assert.equal(failures, 2);
  assert.equal(watchdog.check(), true);
  watchdog.stop();
});
