import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { UploadLimitError, UploadStore } =
  await importTypescriptModule("src/server/upload-store.ts");

function limits(overrides = {}) {
  return {
    maxFileBytes: 16,
    maxRequestBytes: 24,
    maxFiles: 2,
    maxDiskBytes: 32,
    ttlMs: 60_000,
    maxConcurrentRequests: 1,
    ...overrides,
  };
}

function parts(...entries) {
  return (async function* () {
    for (const [filename, contents] of entries) {
      yield { filename, file: Readable.from([Buffer.from(contents)]) };
    }
  })();
}

test("uploads stream to private files and dispose removes them", async () => {
  const store = await UploadStore.create(limits());
  const [upload] = await store.saveParts(parts(["hello.txt", "hello"]));
  assert.equal(await readFile(upload.fsPath, "utf8"), "hello");
  assert.deepEqual(store.usage(), {
    storedBytes: 5,
    inFlightBytes: 0,
    files: 1,
    activeRequests: 0,
  });
  await store.dispose();
  await assert.rejects(access(upload.fsPath));
});

test("request and file-count failures roll back already committed files", async () => {
  const store = await UploadStore.create(limits());
  await assert.rejects(
    store.saveParts(parts(["one", "123456789012345"], ["two", "abcdefghij"])),
    UploadLimitError,
  );
  assert.deepEqual(store.usage(), {
    storedBytes: 0,
    inFlightBytes: 0,
    files: 0,
    activeRequests: 0,
  });
  await assert.rejects(
    store.saveParts(parts(["one", "1"], ["two", "2"], ["three", "3"])),
    /more than 2 files/,
  );
  assert.equal(store.usage().files, 0);
  await store.dispose();
});

test("concurrent uploads are bounded", async () => {
  const store = await UploadStore.create(limits());
  const stream = new PassThrough();
  const first = store.saveParts(
    (async function* () {
      yield { filename: "slow", file: stream };
    })(),
  );
  await delay(10);
  await assert.rejects(
    store.saveParts(parts(["second", "x"])),
    (error) => error instanceof UploadLimitError && error.statusCode === 429,
  );
  stream.end("done");
  await first;
  await store.dispose();
});

test("expired uploads are removed from disk and quota accounting", async () => {
  const store = await UploadStore.create(limits({ ttlMs: 20 }));
  const [upload] = await store.saveParts(parts(["short", "x"]));
  await delay(80);
  await assert.rejects(access(upload.fsPath));
  assert.equal(store.usage().storedBytes, 0);
  await store.dispose();
});
