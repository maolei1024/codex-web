import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

test("Desktop UUIDs work on HTTP with secure entropy and preserve the native implementation", async () => {
  const { installRandomUUID } = await importTypescriptModule(
    "src/browser/crypto-compat.ts",
  );
  const httpCrypto = {
    getRandomValues: (array) => crypto.getRandomValues(array),
  };
  installRandomUUID(httpCrypto);
  const values = new Set(
    Array.from({ length: 100 }, () => httpCrypto.randomUUID()),
  );
  assert.equal(values.size, 100);
  for (const value of values)
    assert.match(
      value,
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
  const native = crypto.randomUUID;
  installRandomUUID(crypto);
  assert.equal(crypto.randomUUID, native);
});

test("reconnect delay uses capped exponential backoff with jitter", async () => {
  const { reconnectDelayMs } = await importTypescriptModule(
    "src/browser/reconnect.ts",
  );
  assert.equal(
    reconnectDelayMs(0, () => 0.5),
    500,
  );
  assert.equal(
    reconnectDelayMs(4, () => 0.5),
    8_000,
  );
  assert.equal(
    reconnectDelayMs(100, () => 0.5),
    15_000,
  );
  assert.equal(
    reconnectDelayMs(0, () => 0),
    375,
  );
  assert.equal(
    reconnectDelayMs(0, () => 1),
    625,
  );
});

test("mobile viewport helper distinguishes keyboard, URL bar and pinch zoom", async () => {
  const { isKeyboardLikelyOpen, shouldInstallGuard } =
    await importTypescriptModule("src/browser/mobile-viewport.ts");
  assert.equal(
    isKeyboardLikelyOpen({
      visualViewportHeight: 400,
      visualViewportScale: 1,
      windowInnerHeight: 800,
    }),
    true,
  );
  assert.equal(
    isKeyboardLikelyOpen({
      visualViewportHeight: 740,
      visualViewportScale: 1,
      windowInnerHeight: 800,
    }),
    false,
  );
  assert.equal(
    isKeyboardLikelyOpen({
      visualViewportHeight: 400,
      visualViewportScale: 2,
      windowInnerHeight: 800,
    }),
    false,
  );
  assert.equal(
    shouldInstallGuard({
      coarsePointer: false,
      narrowViewport: true,
      touchCapable: false,
    }),
    true,
  );
});

test("uploaded files retain their host paths", async () => {
  const { getUploadedFilePath, rememberUploadedFilePaths } =
    await importTypescriptModule("src/browser/uploaded-file-paths.ts");
  const first = {};
  const second = {};
  rememberUploadedFilePaths(
    [first, second],
    [
      { path: "/tmp/first.png" },
      { path: "/tmp/path.txt", fsPath: "/tmp/fs.txt" },
    ],
  );
  assert.equal(getUploadedFilePath(first), "/tmp/first.png");
  assert.equal(getUploadedFilePath(second), "/tmp/fs.txt");
});

test("only composer-related targets trigger paste/drop upload", async () => {
  const { shouldHandleFileEventTarget } = await importTypescriptModule(
    "src/browser/file-event-target.ts",
  );
  class FakeElement extends EventTarget {
    constructor(matches) {
      super();
      this.matches = matches;
    }
    closest(selector) {
      return this.matches.includes(selector) ? this : null;
    }
  }
  globalThis.Element = FakeElement;
  assert.equal(
    shouldHandleFileEventTarget(new FakeElement([".ProseMirror"])),
    true,
  );
  assert.equal(
    shouldHandleFileEventTarget(new FakeElement(["textarea"])),
    false,
  );
  assert.equal(shouldHandleFileEventTarget(new EventTarget()), false);
});
