import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { TransportRecoveryWindow } = await importTypescriptModule(
  "src/browser/transport-recovery-window.ts",
);

function setup(t, budgetMs = 60_000) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let timeouts = 0;
  const window = new TransportRecoveryWindow(
    () => timeouts++,
    Date.now,
    budgetMs,
  );
  t.after(() => window.stop());
  return { window, timeouts: () => timeouts };
}

test("repeated handshake failures share one window and expiry fires only once", (t) => {
  const { window, timeouts } = setup(t);
  assert.equal(window.active, false);
  window.start();
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(10_000);
    window.start();
  }
  assert.equal(window.diagnostics().remainingMs, 10_000);
  t.mock.timers.tick(9_999);
  assert.equal(timeouts(), 0);
  t.mock.timers.tick(1);
  assert.equal(timeouts(), 1);
  assert.equal(window.failed, true);
  assert.equal(window.active, false);
  assert.equal(window.check(), false);
  window.start();
  window.connected();
  t.mock.timers.tick(120_000);
  assert.equal(timeouts(), 1);
  assert.equal(
    window.failed,
    true,
    "a late successful callback cannot reset failure",
  );
  assert.equal(window.diagnostics().remainingMs, 0);
});

test("suspension excludes background time without replenishing spent foreground budget", (t) => {
  const { window, timeouts } = setup(t);
  window.start();
  t.mock.timers.tick(17_000);
  window.suspend();
  assert.equal(window.active, true);
  assert.deepEqual(window.diagnostics(), {
    remainingMs: 43_000,
    failed: false,
    suspended: true,
  });
  t.mock.timers.tick(600_000);
  window.suspend();
  window.start();
  assert.equal(window.check(), true);
  assert.equal(timeouts(), 0);
  window.resume();
  t.mock.timers.tick(20_000);
  window.resume();
  assert.equal(window.diagnostics().remainingMs, 23_000);
  t.mock.timers.tick(23_000);
  assert.equal(timeouts(), 1);
});

test("manual reset replaces an old window and can recover after exhaustion", (t) => {
  const { window, timeouts } = setup(t);
  window.start();
  t.mock.timers.tick(55_000);
  window.reset();
  t.mock.timers.tick(5_000);
  assert.equal(
    timeouts(),
    0,
    "the retired deadline cannot expire a fresh attempt",
  );
  assert.equal(window.diagnostics().remainingMs, 55_000);
  t.mock.timers.tick(55_000);
  assert.equal(timeouts(), 1);
  window.reset();
  assert.equal(window.failed, false);
  assert.equal(window.active, true);
  t.mock.timers.tick(5_000);
  window.connected();
  assert.equal(window.active, false);
  t.mock.timers.tick(120_000);
  assert.equal(timeouts(), 1);
  window.start();
  assert.equal(window.diagnostics().remainingMs, 60_000);
});

test("delayed timer callbacks are checked before a late connection is accepted", (t) => {
  const { window, timeouts } = setup(t);
  window.start();
  t.mock.timers.setTime(100_000);
  window.connected();
  assert.equal(window.failed, true);
  assert.equal(timeouts(), 1);
  t.mock.timers.tick(120_000);
  assert.equal(timeouts(), 1);
});

test("reset while paused starts a fresh suspended window and stop releases the timer", (t) => {
  const { window, timeouts } = setup(t, 10_000);
  window.suspend();
  window.reset();
  t.mock.timers.tick(120_000);
  assert.equal(window.active, true);
  assert.equal(window.diagnostics().remainingMs, 10_000);
  window.resume();
  t.mock.timers.tick(1_000);
  window.stop();
  t.mock.timers.tick(120_000);
  assert.equal(timeouts(), 0);
  assert.equal(window.active, false);
});
