import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

export async function nativeRequestClient(dispatch, lifecycle = () => {}) {
  const source = await readFile(
    "scratch/asar/webview/assets/app-initial-236e1501144c.js",
    "utf8",
  );
  const start = /ECn\s*=\s*(class)/.exec(source);
  const rest = source.slice(start?.index ?? 0);
  const end = /,\s*DCn\s*=\s*class/.exec(rest);
  assert.ok(start && end, "pinned Desktop request client must exist");
  const code = rest.slice(rest.indexOf("class"), end.index);
  let sequence = 0;
  const errors = [];
  const context = {
    window: {
      setTimeout,
      clearTimeout,
      __ELECTRON_SHIM__: { appServerRequestLifecycle: lifecycle },
    },
    Date,
    DOMException,
    Error,
    hCn: {
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
    Wg: String,
    rp: () => `native-${++sequence}`,
    YSn: (params) => params?.threadId,
    fCn: (_method, options) => options?.priority ?? "interactive",
    $T: (_method, source) => source ?? "test",
    F0t: (method) =>
      ["thread/start", "turn/start", "turn/steer"].includes(method),
    TCn: new Set(),
    bCn: { interactive: 64, background: 128, critical: 16 },
    _Cn: 6,
    vCn: 5,
    yCn: 3,
    SCn: 4,
    xCn: 30_000,
    T: { debug() {}, warning() {}, error: (...args) => errors.push(args) },
    uX() {},
    fRt: () => null,
    pCn: (error) => error,
    uCn: () => ({}),
    dCn: () => Promise.resolve(),
    hS: class extends Error {
      constructor(delivery, message) {
        super(message);
        this.delivery = delivery;
        this.name = "AppServerRequestDeliveryError";
      }
    },
  };
  const Client = vm.runInNewContext(`(${code})`, context);
  return { Client, errors, client: new Client("local", dispatch) };
}
