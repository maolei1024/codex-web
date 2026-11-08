import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { importTypescriptModule } from "./import-typescript-module.mjs";
const { createThreadCacheStore, THREAD_CACHE_DATABASE } =
  await importTypescriptModule("src/browser/thread-cache-store.ts");
const codec = await importTypescriptModule("src/browser/thread-cache-codec.ts");
const page = (id, bytes = 100, order = 0) => ({ id, bytes, order, json: "{}" });
function fixture(options = {}) {
  let now = 1;
  const factory = new IDBFactory();
  const notices = [];
  const store = createThreadCacheStore({
    factory: () => factory,
    now: () => now,
    notify: (n) => notices.push(n),
    ...options,
  });
  return { store, factory, notices, tick: (n = 1) => (now += n) };
}
async function write(store, key, pages = [page("p")]) {
  const { ticket } = await store.readPages(key);
  assert.ok(
    await store.savePages(
      key,
      ticket,
      pages,
      pages.map((p) => p.id),
    ),
  );
}
test("LRU uses actual reads/touches, never background writes; evicts whole conversations", async () => {
  const { store, tick, notices } = fixture({ maxThreads: 2 });
  await write(store, "a");
  tick();
  await write(store, "b");
  tick();
  await store.touch("a", "tab");
  await store.release("a", "tab");
  tick();
  await write(store, "b", [page("p", 120)]);
  tick();
  await write(store, "c");
  assert.equal((await store.readPages("b")).pages.length, 0);
  assert.equal((await store.readPages("a")).pages.length, 1);
  assert.equal((await store.stats()).bytes, 200);
  assert.ok(notices.some((n) => n.type === "invalidate" && n.key === "b"));
  store.close();
});
test("count and bytes are both enforced atomically across tabs", async () => {
  const { store, factory } = fixture({ capacityBytes: 250 });
  const second = createThreadCacheStore({
    factory: () => factory,
    capacityBytes: 250,
  });
  await Promise.all([
    write(store, "a", [page("p", 150)]),
    write(second, "b", [page("p", 150)]),
  ]);
  assert.equal((await store.stats()).threads, 1);
  assert.equal((await store.stats()).bytes, 150);
  store.close();
  second.close();
});
test("protected conversations prevent new writes until leases expire", async () => {
  const { store, tick } = fixture({ maxThreads: 1 });
  await write(store, "a");
  await store.touch("a", "one");
  await store.touch("a", "two");
  await store.release("a", "one");
  const { ticket } = await store.readPages("b");
  assert.equal(await store.savePages("b", ticket, [page("p")], ["p"]), null);
  tick(30001);
  await write(store, "b");
  assert.equal((await store.readPages("a")).pages.length, 0);
  store.close();
});
test("large conversations retain recent whole pages, oversized pages are skipped", async () => {
  const { store } = fixture({ maxThreadBytes: 250 });
  await write(store, "a", [
    page("old", 100, 0),
    page("huge", 400, 1),
    page("middle", 150, 2),
    page("new", 100, 3),
  ]);
  assert.deepEqual(
    (await store.readPages("a")).pages.map((p) => p.id),
    ["middle", "new"],
  );
  assert.equal((await store.stats()).bytes, 250);
  store.close();
});
test("clear, disable, deletion and eviction fence delayed writes, even from other tabs", async () => {
  for (const operation of [
    (s) => s.clear(),
    (s) => s.configure({ enabled: false }),
    (s) => s.invalidate("a"),
    async (s) => write(s, "b"),
  ]) {
    const { store, factory } = fixture({ maxThreads: 1 });
    const second = createThreadCacheStore({
      factory: () => factory,
      maxThreads: 1,
    });
    await write(store, "a");
    const { ticket } = await second.readPages("a");
    await operation(store);
    assert.equal(
      await second.savePages("a", ticket, [page("late")], ["late"]),
      null,
    );
    assert.equal((await store.readPages("a"))?.pages.length ?? 0, 0);
    store.close();
    second.close();
  }
});
test("competing snapshots use compare-and-swap; stale tab cannot replace new content", async () => {
  const { store } = fixture();
  const first = await store.readPages("a"),
    second = await store.readPages("a");
  assert.ok(await store.savePages("a", second.ticket, [page("new")], ["new"]));
  assert.equal(
    await store.savePages("a", first.ticket, [page("stale")], ["stale"]),
    null,
  );
  assert.deepEqual(
    (await store.readPages("a")).pages.map((p) => p.id),
    ["new"],
  );
  store.close();
});
test("origin, identity and execution host are independent keys", async () => {
  const { store } = fixture();
  const keys = [
    ["https://a", "one", "host1", "thread"],
    ["https://b", "one", "host1", "thread"],
    ["https://a", "two", "host1", "thread"],
    ["https://a", "one", "host2", "thread"],
  ].map(JSON.stringify);
  for (const [i, key] of keys.entries())
    await write(store, key, [page(String(i))]);
  for (const [i, key] of keys.entries())
    assert.equal((await store.readPages(key)).pages[0].id, String(i));
  store.close();
});
test("unavailable, blocked, incompatible and aborted IDB degrade without throwing", async () => {
  const broken = createThreadCacheStore({
    factory: () => {
      throw new DOMException("denied", "SecurityError");
    },
  });
  assert.equal(await broken.readPages("a"), null);
  assert.equal(await broken.stats(), null);
  broken.close();
  const factory = new IDBFactory();
  const req = factory.open(THREAD_CACHE_DATABASE, 2);
  const db = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const incompatible = createThreadCacheStore({ factory: () => factory });
  assert.equal(await incompatible.readPages("a"), null);
  incompatible.close();
  db.close();
  const blockedFactory = { open: () => ({}) };
  const timeout = createThreadCacheStore({
    factory: () => blockedFactory,
    timeoutMs: 10,
  });
  assert.equal(await timeout.readPages("a"), null);
  timeout.close();
});
test("missing pages invalidate a corrupted conversation", async () => {
  const { store, factory } = fixture();
  await write(store, "a");
  const req = factory.open(THREAD_CACHE_DATABASE, 1);
  const db = await new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result);
  });
  const tx = db.transaction("pages", "readwrite");
  tx.objectStore("pages").clear();
  await new Promise((resolve) => {
    tx.oncomplete = resolve;
  });
  assert.equal(await store.readPages("a"), null);
  assert.equal((await store.stats()).threads, 0);
  db.close();
  store.close();
});
test("codec retains text, code and tool results but excludes binary and privileged state", () => {
  const turn = {
    turnId: "t",
    status: "completed",
    params: {
      input: [
        { type: "text", text: "hi" },
        { type: "image", url: "data:image/png;base64,a" },
      ],
      approvalPolicy: "never",
      apiKey: "secret",
    },
    items: [
      {
        id: "m",
        type: "agentMessage",
        text: "```js\n1\n```",
        auth: { token: "secret" },
      },
      {
        id: "tool",
        type: "tool",
        result: { text: "done", headers: { authorization: "secret" } },
      },
    ],
  };
  const encoded = codec.encodePage("t:page:0", 0, {
    schema: 1,
    turnId: "t",
    offset: 0,
    total: 2,
    details: codec.turnDetails(turn),
    items: turn.items,
    boundary: { olderCursor: "cursor" },
  });
  assert.ok(!encoded.json.includes("secret"));
  assert.ok(!encoded.json.includes("data:image"));
  assert.ok(!encoded.json.includes("approvalPolicy"));
  assert.equal(
    codec.restoreTurns([codec.decodePage(encoded)])[0].items[1].result.text,
    "done",
  );
  assert.throws(
    () => codec.decodePage({ ...encoded, json: '{"schema":9}' }),
    /CorruptPage/,
  );
});

test("quota/transaction failures roll back eviction and data together", async () => {
  for (const failure of ["QuotaExceededError", "AbortError"]) {
    const { store, tick } = fixture({ maxThreads: 1 });
    await write(store, "a");
    const { ticket } = await store.readPages("b");
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "pages") throw new DOMException("fixture", failure);
      return original.apply(this, args);
    };
    try {
      assert.equal(
        await store.savePages("b", ticket, [page("b")], ["b"]),
        null,
      );
    } finally {
      IDBObjectStore.prototype.put = original;
    }
    tick(5001);
    assert.equal((await store.readPages("a")).pages.length, 1);
    assert.equal((await store.readPages("b")).pages.length, 0);
    assert.equal((await store.stats()).threads, 1);
    store.close();
  }
});
test("page reads can select the newest native page without loading older content", async () => {
  const { store } = fixture();
  await write(
    store,
    "a",
    Array.from({ length: 20 }, (_, i) => page(`turn-${i}:page:0`, 100, i)),
  );
  assert.deepEqual(
    (await store.readPages("a", "tab", 5)).pages.map((p) => p.id),
    Array.from({ length: 5 }, (_, i) => `turn-${i + 15}:page:0`),
  );
  store.close();
});
test("saving a refreshed tail preserves unloaded pages and their chronological order", async () => {
  const { store } = fixture();
  const old = Array.from({ length: 12 }, (_, i) =>
    page(`turn-${i}:page:0`, 100, i),
  );
  await write(store, "a", old);
  const tail = Array.from({ length: 5 }, (_, i) =>
    page(`turn-${i + 7}:page:0`, 110, i),
  );
  let ticket = (await store.readPages("a")).ticket;
  assert.ok(
    await store.savePages(
      "a",
      ticket,
      tail,
      tail.map((p) => p.id),
      true,
    ),
  );
  let saved = await store.readPages("a");
  assert.equal(saved.pages.length, 12);
  assert.deepEqual(
    saved.pages.map((p) => p.id),
    old.map((p) => p.id),
  );
  assert.deepEqual(
    saved.pages.map((p) => p.order),
    old.map((p) => p.order),
  );
  ticket = saved.ticket;
  assert.ok(
    await store.savePages(
      "a",
      ticket,
      tail,
      tail.map((p) => p.id),
      false,
    ),
  );
  assert.equal((await store.readPages("a")).pages.length, 5);
  store.close();
});
test("an identity change invalidates unopened conversations only in the old scope", async () => {
  const { store } = fixture();
  const keys = [
    JSON.stringify(["old", "a"]),
    JSON.stringify(["old", "b"]),
    JSON.stringify(["new", "a"]),
  ];
  for (const key of keys) await write(store, key);
  const stale = (await store.readPages(keys[1])).ticket;
  const pendingKey = JSON.stringify(["old", "pending"]);
  const pending = (await store.readPages(pendingKey)).ticket;
  await store.invalidateScope("old");
  assert.equal((await store.stats()).threads, 1);
  assert.equal(await store.savePages(keys[1], stale, [page("p")], ["p"]), null);
  assert.equal((await store.readPages(keys[2])).pages.length, 1);
  assert.equal(
    await store.savePages(pendingKey, pending, [page("p")], ["p"]),
    null,
  );
  store.close();
});
test("a delayed first background write keeps the original viewing time for LRU", async () => {
  const { store, tick } = fixture({ maxThreads: 2 });
  const first = (await store.readPages("a", "tab-a")).ticket;
  tick(10);
  await write(store, "b");
  tick(40000); // The view lease has expired before persistence finishes.
  assert.ok(await store.savePages("a", first, [page("p")], ["p"]));
  await write(store, "c");
  assert.equal((await store.readPages("a")).pages.length, 0);
  assert.equal((await store.readPages("b")).pages.length, 1);
  store.close();
});
test("storage error listeners can refresh usage without recursively retrying storage", async () => {
  let notifications = 0;
  const store = createThreadCacheStore({
    factory() {
      throw new DOMException("fixture", "SecurityError");
    },
    error() {
      notifications++;
      void store.stats();
    },
  });
  assert.equal(await store.stats(), null);
  await new Promise((r) => setImmediate(r));
  assert.equal(notifications, 1);
  assert.equal(await store.stats(), null);
  assert.equal(notifications, 1);
  store.close();
});
test("a refreshed tail removes reverted pages and drops an unconfirmed prefix", async () => {
  const { store } = fixture();
  const old = Array.from({ length: 12 }, (_, i) =>
    page(`turn-${i}:page:0`, 100, i),
  );
  await write(store, "a", old);
  const tail = old.slice(6, 11).map((p, order) => ({ ...p, order }));
  let ticket = (await store.readPages("a")).ticket;
  await store.savePages(
    "a",
    ticket,
    tail,
    tail.map((p) => p.id),
    true,
  );
  let saved = await store.readPages("a");
  assert.deepEqual(
    saved.pages.map((p) => p.id),
    old.slice(0, 11).map((p) => p.id),
  );
  ticket = saved.ticket;
  const rewritten = [page("replacement:page:0")];
  await store.savePages(
    "a",
    ticket,
    rewritten,
    rewritten.map((p) => p.id),
    true,
  );
  saved = await store.readPages("a");
  assert.deepEqual(
    saved.pages.map((p) => p.id),
    ["replacement:page:0"],
  );
  store.close();
});
