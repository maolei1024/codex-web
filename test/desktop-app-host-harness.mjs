import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/** Run the pinned Desktop's entire RPC engine, including its real MessagePort transport. */
export async function nativeAppHostRuntime() {
  const source = await readFile(
    "scratch/asar/webview/assets/app-initial-236e1501144c.js",
    "utf8",
  );
  const start = source.indexOf("function OQt(");
  const marker = /R\$t\s*=\s*qQt/.exec(source.slice(start));
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
    `${source.slice(start, end)}; Bx(); return { connect: R$t, Target: zx, Session: S$t, Transport: C$t };`,
  )(lazy);
  const main = await readFile("scratch/asar/.vite/build/main-C5K7o1Hr.js", "utf8");
  const backendStart = main.indexOf("var WPe = class");
  const backendEnd = main.indexOf("function GPe(", backendStart);
  assert.ok(backendStart > 0 && backendEnd > backendStart);
  runtime.BackendTransport = new Function(`${main.slice(backendStart, backendEnd)}; return WPe;`)();
  return runtime;
}
