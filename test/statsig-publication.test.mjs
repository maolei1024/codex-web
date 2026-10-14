import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

test("Desktop feature publisher sends current SDK values without subscribing to readback", async () => {
  const bundle = await readFile(
    "scratch/asar/webview/assets/app-initial-1ab6fbe93c4f.js",
    "utf8",
  );
  const start = bundle.indexOf("function QZs(");
  const end = bundle.indexOf("function $Zs(", start);
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
    executionValues: {},
  };
  let cleanup;
  const context = {
    pZs: {},
    Xle: (value) => value,
    pCe: {},
    gr: {
      warning: (_message, details) => {
        throw details.sensitive.error;
      },
    },
    eQs: { c: (size) => Array(size).fill(Symbol()) },
    q: {},
    Oi: () => store,
    nn: (key) => {
      subscriptions.push(key);
      return [null, (value) => state.set(key, value)];
    },
    unusedSet: () => {
      assert.fail("atom setters also mount readback subscriptions");
    },
    Lc: (get, key) => {
      assert.notEqual(
        key,
        "statsig_evaluations",
        "even a one-off atom read subscribes",
      );
      return get(key);
    },
    Ho: {
      dispatchMessage: (type, event) => {
        assert.equal(type, "shared-object-set");
        assert.equal(event.key, "statsig_evaluations");
        publications.push(event.value);
      },
    },
    tQs: { default: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
    nQs: {
      useRef: (current) => ({ current }),
      useLayoutEffect() {},
      useEffect: (fn) => {
        cleanup = fn();
      },
    },
    XZs: () => snapshot,
    xZs: async () => {},
    $Zs: (error) => {
      throw error;
    },
    ARi: (value) => value,
    FRi: {},
    rQs: { jsx: () => null },
    _Zs() {},
  };
  const client = {
    loadingStatus: "Ready",
    getDynamicConfig: () => ({ value: {} }),
    on: (key, fn) => listeners.set(key, fn),
    off: (key) => listeners.delete(key),
  };
  const publish = vm.runInNewContext(
    `${bundle.slice(start, end)}; QZs`,
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
