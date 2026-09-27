import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

test("Desktop feature publisher sends current SDK values without subscribing to readback", async () => {
  const bundle = await readFile(
    "scratch/asar/webview/assets/app-initial-236e1501144c.js",
    "utf8",
  );
  const start = bundle.indexOf("function AUo(");
  const end = bundle.indexOf("function jUo(", start);
  assert.ok(start >= 0 && end > start, "pinned Desktop publisher must exist");
  const subscriptions = [],
    publications = [],
    listeners = new Map();
  const state = new Map();
  const store = { get: (key) => state.get(key), set() {} };
  let snapshot = {
    userId: "one",
    payload: "large feature evaluation",
    defaultEnableFeatures: {},
  };
  let cleanup;
  const context = {
    MUo: { c: (size) => Array(size).fill(Symbol()) },
    Q: {},
    hb: () => store,
    iE: (key) => {
      subscriptions.push(key);
      return [null, (value) => state.set(key, value)];
    },
    GT: (_store, key, value) => {
      publications.push(value);
      state.set(key, value);
    },
    KT: (get, key) => get(key),
    NUo: { default: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
    PUo: {
      useCallback: (fn) => fn,
      useLayoutEffect() {},
      useEffect: (fn) => {
        cleanup = fn();
      },
    },
    TUo: () => snapshot,
    SUo: async () => {},
    jUo: (error) => {
      throw error;
    },
    BSa: (value) => value,
    WSa: {},
    FUo: { jsx: () => null },
    vUo() {},
  };
  const client = {
    loadingStatus: "Ready",
    getDynamicConfig: () => ({ value: {} }),
    on: (key, fn) => listeners.set(key, fn),
    off: (key) => listeners.delete(key),
  };
  const publish = vm.runInNewContext(
    `${bundle.slice(start, end)}; AUo`,
    context,
  );
  publish({ client });
  assert.deepEqual(subscriptions, ["statsig_default_enable_features"]);
  assert.equal(publications[0], snapshot);
  listeners.get("values_updated")();
  assert.equal(publications.length, 1, "unchanged values are deduplicated");
  snapshot = { ...snapshot, userId: "two", payload: null };
  listeners.get("values_updated")();
  assert.equal(
    publications[1],
    snapshot,
    "identity/default changes still reach Desktop",
  );
  cleanup();
  assert.equal(listeners.size, 0);
});
