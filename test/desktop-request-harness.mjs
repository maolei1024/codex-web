import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

export async function nativeRequestClient(
  dispatch,
  lifecycle = () => {},
  appHost = { nativeRequest: (_method, operation) => operation() },
) {
  const source = await readFile(
    "scratch/asar/webview/assets/app-shared-8340f229c2b3.js",
    "utf8",
  );
  const start = /Spn\s*=\s*(class)/.exec(source);
  const rest = source.slice(start?.index ?? 0);
  const end = /\)?\s*,\s*\(?Cpn\s*=\s*class/.exec(rest);
  assert.ok(start && end, "pinned Desktop request client must exist");
  const code = rest.slice(rest.indexOf("class"), end.index);
  const lifecycleMetrics = source.slice(
    source.indexOf("function rpn("),
    source.indexOf("function ipn("),
  );
  const optionalConfig = source.slice(
    source.indexOf("async function qin("),
    source.indexOf("function Jin("),
  );
  const normalizeConfig = source.slice(
    source.indexOf("function zrn("),
    source.indexOf("function DV("),
  );
  assert.ok(normalizeConfig, "pinned Desktop config normalization must exist");
  let sequence = 0;
  const errors = [];
  const context = {
    zrn: vm.runInNewContext(`(${normalizeConfig})`),
    opn: () => false,
    OP: () => null,
    $fn: (_method, source) => source ?? "test",
    window: {
      setTimeout,
      clearTimeout,
      __ELECTRON_SHIM__: { appServerRequestLifecycle: lifecycle, appHost },
    },
    Date,
    DOMException,
    Error,
    dpn: {
      default: (fn, { normalizer }) => {
        const cache = new Map();
        const memo = (...args) => {
          const key = normalizer(args);
          if (!cache.has(key)) cache.set(key, fn(...args));
          return cache.get(key);
        };
        memo.delete = (...args) => cache.delete(normalizer(args));
        return memo;
      },
    },
    jj: String,
    JT: () => `native-${++sequence}`,
    Ufn: (params) => params?.threadId,
    cpn: (_method, options) => options?.priority ?? "interactive",
    spn: (_method, source) => source ?? "test",
    K0t: (method) =>
      ["thread/start", "turn/start", "turn/steer"].includes(method),
    xpn: new Set(),
    gpn: { interactive: 64, background: 128, critical: 16 },
    ppn: 6,
    mpn: 5,
    hpn: 3,
    vpn: 4,
    _pn: 30_000,
    zf: { debug() {}, warning() {}, error: (...args) => errors.push(args) },
    l6() {},
    n6: () => null,
    lpn: (error) => error,
    rpn: vm.runInNewContext(`(${lifecycleMetrics})`),
    ipn: () => Promise.resolve(),
    lz: class extends Error {
      constructor(delivery, message) {
        super(message);
        this.delivery = delivery;
        this.name = "AppServerRequestDeliveryError";
      }
    },
  };
  const Client = vm.runInNewContext(`(${code})`, context);
  const readOptionalConfig = vm.runInNewContext(`(${optionalConfig})`, {
    DM: () => false,
    DV: (config) => config,
  });
  return {
    Client,
    errors,
    client: new Client("local", dispatch),
    readOptionalConfig,
  };
}
