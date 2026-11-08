import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
test("packaged cache Worker URL resolves inside the versioned asset tree", async () => {
  const source = await readFile(
    "scratch/asar/webview/assets/preload.js",
    "utf8",
  );
  const worker = /["']([^"']*thread-cache-worker-[^"']+\.js)["']/.exec(source);
  assert.ok(worker, "cache codec must run in a real packaged Worker");
  const build = JSON.parse(await readFile("local-build.json", "utf8"));
  const prefix = `/assets/__build/${build.id}/`;
  const url = new URL(worker[1], `https://fixture${prefix}preload.js`);
  assert.ok(url.pathname.startsWith(prefix));
  const filename = path.join(
    "scratch/asar/webview/assets",
    url.pathname.slice(prefix.length),
  );
  assert.ok((await stat(filename)).isFile());
  assert.ok((await stat(`${filename}.br`)).isFile());
});
