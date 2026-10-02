import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

test("Desktop feature publisher sends current SDK values without subscribing to readback", async () => {
  const bundle = await readFile(
    "scratch/asar/webview/assets/app-initial-60d038a052d7.js",
    "utf8",
  );
  const start = bundle.indexOf("function PPs(");
  const end = bundle.indexOf("function FPs(", start);
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
    qNs: {},
    eee: (value) => value,
    NXe: {},
    Nu: {
      warning: (_message, details) => {
        throw details.sensitive.error;
      },
    },
    IPs: { c: (size) => Array(size).fill(Symbol()) },
    q: {},
    Ah: () => store,
    Al: (key) => {
      subscriptions.push(key);
      return [null, (value) => state.set(key, value)];
    },
    unusedSet: () => {
      assert.fail("atom setters also mount readback subscriptions");
    },
    gd: (get, key) => {
      assert.notEqual(
        key,
        "statsig_evaluations",
        "even a one-off atom read subscribes",
      );
      return get(key);
    },
    _s: {
      dispatchMessage: (type, event) => {
        assert.equal(type, "shared-object-set");
        assert.equal(event.key, "statsig_evaluations");
        publications.push(event.value);
      },
    },
    LPs: { default: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
    RPs: {
      useRef: (current) => ({ current }),
      useLayoutEffect() {},
      useEffect: (fn) => {
        cleanup = fn();
      },
    },
    wPs: () => snapshot,
    kPs: async () => {},
    FPs: (error) => {
      throw error;
    },
    m5r: (value) => value,
    y5r: {},
    zPs: { jsx: () => null },
    ZNs() {},
  };
  const client = {
    loadingStatus: "Ready",
    getDynamicConfig: () => ({ value: {} }),
    on: (key, fn) => listeners.set(key, fn),
    off: (key) => listeners.delete(key),
  };
  const publish = vm.runInNewContext(
    `${bundle.slice(start, end)}; PPs`,
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
