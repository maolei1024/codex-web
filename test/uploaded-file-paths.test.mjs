import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

test("rememberUploadedFilePaths lets getUploadedFilePath return uploaded host paths", async () => {
  const { getUploadedFilePath, rememberUploadedFilePaths } =
    await importTypescriptModule("src/browser/uploaded-file-paths.ts");
  const first = {};
  const second = {};

  rememberUploadedFilePaths(
    [first, second],
    [
      { label: "first.png", path: "/tmp/uploads/first.png" },
      {
        label: "second.txt",
        path: "/tmp/uploads/path-second.txt",
        fsPath: "/tmp/uploads/fs-second.txt",
      },
    ],
  );

  assert.equal(getUploadedFilePath(first), "/tmp/uploads/first.png");
  assert.equal(getUploadedFilePath(second), "/tmp/uploads/fs-second.txt");
});

test("rememberUploadedFilePaths ignores upload results without usable paths", async () => {
  const { getUploadedFilePath, rememberUploadedFilePaths } =
    await importTypescriptModule("src/browser/uploaded-file-paths.ts");
  const file = {};

  rememberUploadedFilePaths([file], [{ label: "missing-path" }]);

  assert.equal(getUploadedFilePath(file), null);
});

test("shouldHandleFileEventTarget only handles composer file targets", async () => {
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
    shouldHandleFileEventTarget(
      new FakeElement(['[data-testid="composer-input"]']),
    ),
    true,
  );
  assert.equal(
    shouldHandleFileEventTarget(
      new FakeElement(["[data-composer-attachments-row]"]),
    ),
    true,
  );
  assert.equal(
    shouldHandleFileEventTarget(
      new FakeElement(["[data-composer-overlay-floating-ui]"]),
    ),
    true,
  );
  assert.equal(
    shouldHandleFileEventTarget(new FakeElement(["textarea"])),
    false,
  );
  assert.equal(shouldHandleFileEventTarget(new EventTarget()), false);
});
