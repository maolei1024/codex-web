import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/** Run the pinned Desktop's entire RPC engine, including its real MessagePort transport. */
export async function nativeAppHostRuntime() {
  const source = await readFile(
    "scratch/asar/webview/assets/app-shared-8340f229c2b3.js",
    "utf8",
  );
  const start = source.indexOf("function JP(");
  const marker = /nIt\s*=\s*hFt/.exec(source.slice(start));
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
    `${source.slice(start, end)}; yF(); return { connect: nIt, Target: QP, Session: BFt, Transport: VFt };`,
  )(lazy);
  const main = await readFile(
    "scratch/asar/.vite/build/main-CwxgTOle.js",
    "utf8",
  );
  const backendStart = main.indexOf("var EXe = class");
  const backendEnd = main.indexOf("function OXe(", backendStart);
  assert.ok(backendStart > 0 && backendEnd > backendStart);
  runtime.BackendTransport = new Function(
    `${main.slice(backendStart, backendEnd)}; return EXe;`,
  )();
  return runtime;
}
