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

test("websocket SSH recovery replays its real connected snapshot before initialization", () => {
  const recovery = new ReconnectRecovery();
  const remote = { ...initialized("remote"), transport: "websocket" };
  const connected = {
    type: "codex-app-server-connection-changed",
    hostId: "remote",
    transport: "websocket",
    state: "connected",
    progress: null,
    error: null,
    isSnapshot: true,
  };
  recovery.observe(remote);
  recovery.begin();
  assert.deepEqual(
    recovery.pending(),
    [],
    "initialization alone cannot assert connectivity",
  );
  recovery.observe(connected);
  assert.deepEqual(recovery.pending(), [
    { ...connected, isSnapshot: false },
    { ...remote, isSnapshot: false },
  ]);
  assert.deepEqual(recovery.pending(), []);
  assert.equal(connected.isSnapshot, true);

  recovery.begin();
  recovery.observe({ ...connected, state: "error" });
  assert.deepEqual(
    recovery.pending(),
    [],
    "an old initialized host must not look connected",
  );
  recovery.observe(connected);
  assert.equal(recovery.pending().length, 2);
});

test("a real websocket reconnect already triggers native stream recovery and is not replayed", () => {
  const recovery = new ReconnectRecovery();
  recovery.observe({ ...initialized("remote"), transport: "websocket" });
  recovery.begin();
  recovery.observe({
    type: "codex-app-server-connection-changed",
    hostId: "remote",
    transport: "websocket",
    state: "connected",
    isSnapshot: false,
  });
  assert.deepEqual(recovery.pending(), []);
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
