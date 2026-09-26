import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { compactJavascript } from "../scripts/compact-assets.mjs";

test("asset compaction preserves names, side effects, literals and legal notices", async () => {
  const source = `/*! @license retained */
    function publicName(value) {
      return value + "日本語 spaces  remain";
    }
    globalThis.answer = publicName(42);
    globalThis.exportedName = publicName.name;
    globalThis.asset = "/assets/__build/test/file.js";
  `;
  const result = await compactJavascript("fixture.js", source);
  const first = {},
    second = {};
  vm.runInNewContext(source, first);
  vm.runInNewContext(result, second);
  assert.equal(first.answer, second.answer);
  assert.equal(first.exportedName, second.exportedName);
  assert.equal(first.asset, second.asset);
  assert.match(result, /@license retained/);
  assert.ok(result.length < source.length);
  assert.equal(await compactJavascript("fixture.js", result), result);
});
