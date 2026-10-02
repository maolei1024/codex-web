import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/** Run the pinned Desktop's entire RPC engine, including its real MessagePort transport. */
export async function nativeAppHostRuntime() {
  const source = await readFile(
    "scratch/asar/webview/assets/app-shared-59042e7300f7.js",
    "utf8",
  );
  const start = source.indexOf("function uI(");
  const marker = /vVt\s*=\s*jBt/.exec(source.slice(start));
  const end = source.indexOf("function ", start + marker.index);
  assert.ok(
    start > 0 && end > start,
    "pinned native RPC implementation must be present",
  );
  const lazy = (initialize) => {
    let initialized = false;
    return () => {
      if (!initialized) {
        initialized = true;
        initialize();
      }
    };
  };
  const runtime = new Function(
    "t",
    `${source.slice(start, end)}; FI(); return { connect: vVt, Target: mI, Session: nVt, Transport: rVt };`,
  )(lazy);
  const main = await readFile(
    "scratch/asar/.vite/build/main-C3nRcJ3D.js",
    "utf8",
  );
  const backendStart = main.indexOf("var Xqe = class");
  const backendEnd = main.indexOf("function Qqe(", backendStart);
  assert.ok(backendStart > 0 && backendEnd > backendStart);
  runtime.BackendTransport = new Function(
    `${main.slice(backendStart, backendEnd)}; return Xqe;`,
  )();
  return runtime;
}
