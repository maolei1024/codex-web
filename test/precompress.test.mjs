import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const preloadPath = "scratch/asar/webview/assets/preload.js";

test("preload plain, Brotli and gzip assets contain identical bytes", async () => {
  const [plain, brotli, gzip] = await Promise.all([
    readFile(preloadPath),
    readFile(`${preloadPath}.br`),
    readFile(`${preloadPath}.gz`),
  ]);
  assert.deepEqual(brotliDecompressSync(brotli), plain);
  assert.deepEqual(gunzipSync(gzip), plain);
});

test("webview includes credentialed PWA and mobile viewport fixes", async () => {
  const html = await readFile("scratch/asar/webview/index.html", "utf8");
  assert.match(
    html,
    /rel="manifest" href="\/manifest\.json" crossorigin="use-credentials"/,
  );
  assert.match(html, /interactive-widget=resizes-content/);
  assert.match(html, /--codex-web-visual-viewport-height/);
  assert.match(html, /#root > div\[style\*="100vh"\]/);
});
