import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

export async function nativeRequestClient(
  dispatch,
  lifecycle = () => {},
  appHost = { nativeRequest: (_method, operation) => operation() },
) {
  const source = await readFile(
    "scratch/asar/webview/assets/app-shared-59042e7300f7.js",
    "utf8",
  );
  const start = /Bun\s*=\s*(class)/.exec(source);
  const rest = source.slice(start?.index ?? 0);
  const end = /\)?\s*,\s*\(?Vun\s*=\s*class/.exec(rest);
  assert.ok(start && end, "pinned Desktop request client must exist");
  const code = rest.slice(rest.indexOf("class"), end.index);
  let sequence = 0;
  const errors = [];
  const context = {
    wun: () => false,
    xP: () => null,
    _un: (_method, source) => source ?? "test",
    window: {
      setTimeout,
      clearTimeout,
      __ELECTRON_SHIM__: { appServerRequestLifecycle: lifecycle, appHost },
    },
    Date,
    DOMException,
    Error,
    kun: {
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
    xj: String,
    sE: () => `native-${++sequence}`,
    sun: (params) => params?.threadId,
    Eun: (_method, options) => options?.priority ?? "interactive",
    Tun: (_method, source) => source ?? "test",
    PQt: (method) =>
      ["thread/start", "turn/start", "turn/steer"].includes(method),
    zun: new Set(),
    Pun: { interactive: 64, background: 128, critical: 16 },
    jun: 6,
    Mun: 5,
    Nun: 3,
    Iun: 4,
    Fun: 30_000,
    mf: { debug() {}, warning() {}, error: (...args) => errors.push(args) },
    p6() {},
    o6: () => null,
    Dun: (error) => error,
    xun: () => ({}),
    Sun: () => Promise.resolve(),
    SR: class extends Error {
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
