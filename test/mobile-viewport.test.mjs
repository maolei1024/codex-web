import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { isKeyboardLikelyOpen, shouldInstallGuard } =
  await importTypescriptModule("src/browser/mobile-viewport.ts");

test("keyboard is detected when the visual viewport shrinks at 1:1 scale", () => {
  assert.equal(
    isKeyboardLikelyOpen({
      visualViewportHeight: 400,
      visualViewportScale: 1,
      windowInnerHeight: 800,
    }),
    true,
  );
});

test("URL bar show/hide (small height delta) is not treated as a keyboard", () => {
  assert.equal(
    isKeyboardLikelyOpen({
      visualViewportHeight: 740,
      visualViewportScale: 1,
      windowInnerHeight: 800,
    }),
    false,
  );
});

test("pinch zoom is not treated as a keyboard", () => {
  assert.equal(
    isKeyboardLikelyOpen({
      visualViewportHeight: 400,
      visualViewportScale: 2,
      windowInnerHeight: 800,
    }),
    false,
  );
});

test("guard installs when any mobile signal is present", () => {
  assert.equal(
    shouldInstallGuard({
      coarsePointer: true,
      narrowViewport: false,
      touchCapable: false,
    }),
    true,
  );
  assert.equal(
    shouldInstallGuard({
      coarsePointer: false,
      narrowViewport: true,
      touchCapable: false,
    }),
    true,
  );
  assert.equal(
    shouldInstallGuard({
      coarsePointer: false,
      narrowViewport: false,
      touchCapable: true,
    }),
    true,
  );
});

test("guard does not install on a plain desktop browser", () => {
  assert.equal(
    shouldInstallGuard({
      coarsePointer: false,
      narrowViewport: false,
      touchCapable: false,
    }),
    false,
  );
});
