import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { ConnectionWatchdog } = await importTypescriptModule(
  "src/browser/connection-watchdog.ts",
);

test("a sleeping page discards an overdue ping and probes again on wakeup", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let timeouts = 0,
    sent = 0;
  const watchdog = new ConnectionWatchdog(() => timeouts++);
  watchdog.opened();
  watchdog.probe("before-sleep", () => sent++);
  t.mock.timers.tick(2_000);
  watchdog.suspend();
  t.mock.timers.tick(3_600_000);
  assert.equal(watchdog.check(), true);
  watchdog.probe("hidden", () => sent++);
  assert.equal(timeouts, 0);
  assert.equal(sent, 1);
  watchdog.resume();
  watchdog.probe("after-wakeup", () => sent++);
  watchdog.pong("before-sleep");
  t.mock.timers.tick(4_999);
  assert.equal(timeouts, 0);
  watchdog.pong("after-wakeup");
  t.mock.timers.tick(60_000);
  assert.equal(sent, 2);
  assert.equal(timeouts, 0);
  watchdog.stop();
});

test("a handshake resumed from background receives one bounded verification window", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let timeouts = 0;
  const watchdog = new ConnectionWatchdog(() => timeouts++);
  t.mock.timers.tick(8_000);
  watchdog.suspend();
  t.mock.timers.tick(3_600_000);
  watchdog.resume();
  t.mock.timers.tick(9_000);
  watchdog.resume();
  assert.equal(timeouts, 0);
  t.mock.timers.tick(1_000);
  assert.equal(timeouts, 1);
  watchdog.check();
  assert.equal(timeouts, 1);
});

test("a handshake completed while hidden is retained without an extra connection deadline", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let timeouts = 0;
  const watchdog = new ConnectionWatchdog(() => timeouts++);
  watchdog.suspend();
  watchdog.opened();
  t.mock.timers.tick(3_600_000);
  watchdog.resume();
  t.mock.timers.tick(60_000);
  assert.equal(timeouts, 0);
  watchdog.probe("fresh", () => {});
  t.mock.timers.tick(5_000);
  assert.equal(timeouts, 1);
});
