import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importTypescriptModule } from "./import-typescript-module.mjs";
const recovery = await importTypescriptModule("src/server/startup-recovery.ts");
const source = await readFile(
  "scratch/asar/.vite/build/main-C5K7o1Hr.js",
  "utf8",
);
const start = source.indexOf("var FL = class extends hL");
const end = source.indexOf("function LL()", start);
assert.ok(start > 0 && end > start);
const n = {
  Xi: { conversationDetailMode: { key: "detail" } },
  ea: { openLinkInTargetPreference: { key: "open" } },
  Ki: (_, v) => v,
};
const Settings = new Function(
  "n",
  "hL",
  `${source.slice(start, end)}; return FL;`,
)(n, class {});
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test("native display settings return unavailable in one second, coalescing uncancellable identity reads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let calls = 0,
    complete,
    changes = 0;
  const statsig = {
    identityEpoch: 0,
    publications: [{}],
    listeners: new Set([
      () => {
        changes++;
      },
    ]),
    readExecutionAssignments: () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  };
  const settings = new Settings(
    { get: () => "configured", getEffective: () => "native-local" },
    () => {},
    statsig,
  );
  settings.workModeAccessByAccount = [
    { accountId: "a", userId: "u", policy: "everyday" },
  ];
  const first = settings.getEffective("detail");
  await tick();
  t.mock.timers.tick(1_000);
  await tick();
  assert.equal(await first, undefined);
  assert.equal(await settings.getEffective("unrelated"), "native-local");
  const retry = settings.getEffective("detail");
  await tick();
  t.mock.timers.tick(1_000);
  await tick();
  assert.equal(await retry, undefined);
  assert.equal(calls, 1);
  complete({ identity: { accountId: "a", userId: "u" } });
  await tick();
  assert.equal(changes, 1);
  assert.equal(await settings.getEffective("detail"), "STEPS_PROSE");
  assert.equal(
    await settings.getEffective("detail", { accountId: "other", userId: "u" }),
    undefined,
  );
});

test("identity changes discard late display results and never share assignments between accounts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let complete;
  const statsig = {
    identityEpoch: 0,
    publications: [{}],
    listeners: new Set(),
    readExecutionAssignments: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  };
  const first = recovery.displayAssignments(statsig);
  await tick();
  statsig.identityEpoch++;
  complete({ identity: { accountId: "old" } });
  await tick();
  assert.equal(await first, null);
  const next = recovery.displayAssignments(statsig);
  await tick();
  complete({ identity: { accountId: "new" } });
  await tick();
  assert.equal((await next).identity.accountId, "new");
});
