import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { createImageDrafts, durableImages } = await importTypescriptModule(
  "src/browser/image-drafts.ts",
);
const image = {
  id: "one",
  src: "data:image/png;base64,AQID",
  filename: "example.png",
  localPath: "/expired/upload",
  uploadStatus: "idle",
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function memoryStorage() {
  const rows = new Map();
  return {
    rows,
    read: async (key) => structuredClone(rows.get(key)),
    write: async (key, images) => {
      if (images.length) rows.set(key, structuredClone(images));
      else rows.delete(key);
    },
  };
}

test("image pixels survive a new page, without stale server paths or large localStorage entries", async () => {
  const storage = memoryStorage();
  await createImageDrafts(storage).save("task-a", [image]);
  const nextPage = createImageDrafts(storage);
  let restored;
  nextPage.mount(
    "task-a",
    () => [],
    (images) => {
      restored = images;
    },
  );
  nextPage.mount(
    "task-b",
    () => [],
    () => assert.fail("draft crossed task boundary"),
  );
  await tick();
  assert.deepEqual(restored, [
    {
      id: image.id,
      src: image.src,
      filename: image.filename,
      uploadStatus: "idle",
    },
  ]);
});

test("restored cloud images use retained pixels and re-enter the normal upload path", () => {
  assert.deepEqual(
    durableImages([
      {
        ...image,
        src: "cloud-file-id",
        uploadSrc: image.src,
        uploadStatus: "uploaded",
      },
    ]),
    durableImages([image]),
  );
  assert.deepEqual(
    durableImages([null, { id: "bad", src: "blob:expired" }, image, image]),
    durableImages([image]),
  );
  assert.deepEqual(durableImages({}), []);
});

test("delete/send wins over queued slow saves and is still empty after refresh", async () => {
  const storage = memoryStorage();
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const originalWrite = storage.write;
  storage.write = async (...args) => {
    await blocker;
    await originalWrite(...args);
  };
  const drafts = createImageDrafts(storage);
  const first = drafts.save("task", [image]);
  const last = drafts.save("task", []);
  release();
  await Promise.all([first, last]);
  createImageDrafts(storage).mount(
    "task",
    () => [],
    () => assert.fail("sent image reappeared"),
  );
  await tick();
  assert.equal(storage.rows.size, 0);
});

test("late reads cannot replace new attachments, undo clears or restore an unmounted composer", async () => {
  for (const action of ["edit", "clear", "unmount", "existing"]) {
    let release;
    const storage = memoryStorage();
    storage.read = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const drafts = createImageDrafts(storage);
    const dispose = drafts.mount(
      "task",
      () => (action === "existing" ? [image] : []),
      () => assert.fail(action),
    );
    await tick();
    if (action === "edit") await drafts.save("task", [{ ...image, id: "new" }]);
    if (action === "clear") await drafts.save("task", []);
    if (action === "unmount") dispose();
    release([image]);
    await tick();
  }
});

test("storage errors preserve live attachments and report failure without unhandled rejections", async () => {
  let errors = 0;
  const storage = memoryStorage();
  await storage.write("task", [image]);
  const write = storage.write;
  storage.write = (key, images) =>
    images.length ? Promise.reject(new Error("quota")) : write(key, images);
  const drafts = createImageDrafts(storage, () => {
    errors++;
  });
  assert.deepEqual(await drafts.save("task", [{ ...image, id: "new" }]), {
    ok: false,
    reason: "storage",
  });
  assert.deepEqual(await drafts.checkpoint("task"), {
    ok: false,
    reason: "storage",
  });
  assert.equal(errors, 1);
  assert.equal(storage.rows.size, 0, "failed saves must not revive old images");
  storage.read = async () => {
    throw new Error("disabled");
  };
  drafts.mount(
    "task",
    () => [image],
    () => assert.fail("replaced live images"),
  );
  await tick();
  assert.equal(errors, 2);
});

test("draft checkpoint reports attachments that are still being read", async () => {
  const drafts = createImageDrafts(memoryStorage());
  assert.deepEqual(
    await drafts.save("task", [{ id: "pending", src: "blob:reading" }]),
    { ok: false, reason: "incomplete" },
  );
  assert.equal((await drafts.checkpoint("task")).ok, false);
  assert.equal((await drafts.save("task", [image])).ok, true);
  assert.equal((await drafts.checkpoint("task")).ok, true);
});

test("Desktop composer mutations save images only when changed, including send/reset", async () => {
  const bundle = await readFile(
    "scratch/asar/webview/assets/app-initial-60d038a052d7.js",
    "utf8",
  );
  const start = bundle.indexOf("function rR(");
  const end = bundle.indexOf("function Kur(", start);
  assert.ok(start > 0 && end > start);
  let state = {
    imageAttachments: [image],
    attachmentOrder: [],
    imageCommentDrafts: [],
    appshotContexts: [],
    fileAttachments: [],
    pastedTextAttachments: [],
    uploadedFileAttachments: [],
    addedFiles: [],
    mcpAppModelContextAttachments: [],
    selectedTextAttachments: [],
    responseTextAnnotations: [],
    pullRequestChecks: [],
  };
  const saved = [],
    home = [];
  const context = {
    a9n: (_old, next) =>
      next.imageAttachments.map((image) => `image:${image.id}`),
    aL: (type, id) => `${type}:${id}`,
    dR: "draft",
    _R: "context",
    gfr: "attachment",
    mnr() {},
    Enr() {},
    mfr: "context",
    fR: "view",
    Xdr: "view",
    Gdr: "home",
    vWe: (value, update) => {
      const next = {
        ...value,
        ...Object.fromEntries(
          Object.entries(value)
            .filter(([, v]) => Array.isArray(v))
            .map(([k, v]) => [k, [...v]]),
        ),
      };
      update(next);
      for (const [key, old] of Object.entries(value))
        if (
          Array.isArray(old) &&
          Array.isArray(next[key]) &&
          old.length === next[key].length &&
          old.every((item, index) => item === next[key][index])
        )
          next[key] = old;
      return next;
    },
    X7n: (scope) => scope.value.key,
    fS: (value) => value.key,
    window: {
      __ELECTRON_SHIM__: {
        imageDrafts: { save: (key, images) => saved.push({ key, images }) },
      },
    },
    L7n() {},
    nR() {},
    kur() {},
    Q7n() {},
    udr() {},
    g7n() {},
    pee() {},
    Odr: "i",
    sfr: "l",
    cnr: "d",
    Vdr: "u",
  };
  const { rR, Gur } = vm.runInNewContext(
    `${bundle.slice(start, end)}; ({rR, Gur})`,
    context,
  );
  const scope = {
    value: { kind: "new", entrypoint: "home", key: "home" },
    get: (key) => (key === "context" ? [] : state),
    set: (key, value, third) => {
      if (key === "view") state = value;
      if (key === "home") home.push(third.images);
    },
  };
  rR(scope, (next) => {
    next.prompt = "typing does not copy image data";
  });
  assert.equal(saved.length, 0);
  rR(scope, (next) => {
    next.imageAttachments = [image, { ...image, id: "two" }];
  });
  assert.equal(saved.at(-1).images.length, 2);
  Gur(scope);
  assert.equal(saved.at(-1).images.length, 0);
  assert.equal(home.at(-1).length, 0);
  assert.equal(state.imageAttachments.length, 0);
});
