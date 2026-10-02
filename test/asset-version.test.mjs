import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { rewriteAssetUrls } from "../scripts/version-assets.mjs";

test("asset namespace is idempotent and leaves unrelated URLs and relative imports intact", () => {
  const source =
    '<script src="/assets/preload.js"></script> import "./relative.js"; url(/assets/font.woff2); const api = `/wham/shared_threads/${id}/assets/${file}`; const external="https://example.org/assets/icon.svg";';
  const versioned = rewriteAssetUrls(source, "build-one");
  assert.match(versioned, /\/assets\/__build\/build-one\/preload.js/);
  assert.match(versioned, /url\(\/assets\/__build\/build-one\/font.woff2\)/);
  assert.ok(versioned.includes('import "./relative.js"'));
  assert.ok(versioned.includes("`/wham/shared_threads/${id}/assets/${file}`"));
  assert.ok(versioned.includes('"https://example.org/assets/icon.svg"'));
  assert.equal(rewriteAssetUrls(versioned, "build-one"), versioned);
  assert.equal(
    rewriteAssetUrls(versioned, "build-two"),
    rewriteAssetUrls(source, "build-two"),
  );
  assert.throws(() => rewriteAssetUrls(source, "../escape"));
});

test("published HTML and patched SDK use this build's preload and configuration hook", async () => {
  const build = JSON.parse(await readFile("local-build.json", "utf8"));
  const html = await readFile("scratch/asar/webview/index.html", "utf8");
  assert.ok(html.includes(`/assets/__build/${build.id}/preload.js`));
  assert.ok(html.includes(`/assets/__build/${build.id}/index-`));
  assert.doesNotMatch(html, /["']\/assets\/(?!__build\/)/);
  const initial = await readFile(
    "scratch/asar/webview/assets/app-shared-59042e7300f7.js",
    "utf8",
  );
  assert.match(initial, /__ELECTRON_SHIM__\.configureStatsigClient/);
});

test("document-relative asset entries use the namespace without rewriting module-relative assets", () => {
  const html = '<script src="./assets/preload.js"></script>';
  assert.equal(
    rewriteAssetUrls(html, "test", true),
    '<script src="/assets/__build/test/preload.js"></script>',
  );
  assert.equal(rewriteAssetUrls(html, "test", false), html);
});
