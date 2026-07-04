import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { reconnectDelayMs } = await importTypescriptModule(
  "src/browser/reconnect.ts",
);

test("reconnectDelayMs doubles from the base delay", () => {
  const midpoint = () => 0.5;
  assert.equal(reconnectDelayMs(0, midpoint), 500);
  assert.equal(reconnectDelayMs(1, midpoint), 1000);
  assert.equal(reconnectDelayMs(2, midpoint), 2000);
  assert.equal(reconnectDelayMs(3, midpoint), 4000);
  assert.equal(reconnectDelayMs(4, midpoint), 8000);
});

test("reconnectDelayMs caps at the max delay", () => {
  assert.equal(reconnectDelayMs(10, () => 0.5), 15000);
  assert.equal(reconnectDelayMs(100, () => 0.5), 15000);
});

test("reconnectDelayMs jitters within ±25%", () => {
  assert.equal(reconnectDelayMs(0, () => 0), 375);
  assert.equal(reconnectDelayMs(0, () => 1), 625);
  assert.equal(reconnectDelayMs(10, () => 0), 11250);
  assert.equal(reconnectDelayMs(10, () => 1), 18750);
});
