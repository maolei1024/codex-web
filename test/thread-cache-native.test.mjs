import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import {
  cacheModules,
  desktopThreadRuntime,
  makeManager,
} from "./desktop-thread-cache-harness.mjs";
const m = await cacheModules(),
  runtime = await desktopThreadRuntime();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await pause(10);
  }
  throw Error("condition timed out");
}
const turn = (text = "cached", status = "completed") => ({
  turnId: "turn-one",
  status,
  params: {
    input: [{ type: "text", text: "fixture" }],
    approvalPolicy: "never",
  },
  items: [{ id: "message-one", type: "agentMessage", text }],
});
const state = (turns = [], resumeState = "needs_resume") => ({
  id: "thread",
  hostId: "local",
  turns,
  resumeState,
  requests: [],
  latestModel: "real-model",
  latestReasoningEffort: "high",
  latestTokenUsageInfo: null,
  turnsPagination: { hasLoadedOldest: true },
});
function setup({
  delayDecode,
  identity = "account-one",
  configureManager,
} = {}) {
  const native = makeManager(runtime, identity);
  configureManager?.(native.manager);
  native.states.set("thread", state());
  const store = m.createThreadCacheStore({ factory: () => new IDBFactory() });
  // Use one factory per database, shared by reopen attempts.
  const codec = async (op, p) => {
    if (op === "decode" && delayDecode) await delayDecode;
    return op === "encode"
      ? m.encodePage(p.id, p.order, p.data)
      : m.decodePage(p);
  };
  const cache = m.createThreadCache({
    store,
    codec,
    origin: "https://fixture",
    tab: "tab",
    channel: null,
  });
  const scope = JSON.stringify([
    "https://fixture",
    "account-one",
    "local",
    "execution-local",
  ]);
  const key = JSON.stringify([scope, "thread"]);
  const dispose = cache.attach(native.manager, native.native);
  let latest;
  return {
    ...native,
    store,
    cache,
    key,
    codec,
    listen() {
      return native.subscriptions.subscribe({
        type: "conversation",
        key: { threadId: "thread" },
        listener: (value) => {
          latest = value;
        },
      });
    },
    get latest() {
      return latest;
    },
    async seed() {
      const t = turn();
      const p = m.encodePage("turn-one:page:0", 0, {
        schema: 1,
        turnId: t.turnId,
        offset: 0,
        total: 1,
        details: m.turnDetails(t),
        items: t.items,
        boundary: null,
      });
      const { ticket } = await store.readPages(key);
      await store.savePages(key, ticket, [p], [p.id]);
    },
    dispose() {
      dispose();
      store.close();
    },
  };
}
test("real native transcript displays cache while backend resume state and permissions stay native", async () => {
  const f = setup();
  await f.seed();
  const off = f.listen();
  await until(() => f.cache.diagnostics().hits === 1);
  assert.equal(f.latest.value.resumeState, "needs_resume");
  assert.equal(
    f.latest.value.itemsByKey['["turn:turn-one","message-one"]'].text,
    "cached",
  );
  assert.deepEqual(f.manager.getConversation("thread").turns, []);
  assert.equal(
    f.subscriptions.owner.getConversation("thread").latestModel,
    "real-model",
  );
  assert.equal(
    f.latest.value.turnsByKey["turn:turn-one"].details.params.approvalPolicy,
    undefined,
  );
  f.set("thread", state([turn("new from backend")], "resumed"));
  assert.equal(
    f.latest.value.itemsByKey['["turn:turn-one","message-one"]'].text,
    "new from backend",
  );
  assert.equal(f.latest.value.resumeState, "resumed");
  assert.equal(f.cache.diagnostics().syncing, 0);
  off();
  f.dispose();
});
test("late cache cannot replace new native messages or a different connection generation", async () => {
  for (const disconnect of [false, true]) {
    let release;
    const delayDecode = new Promise((r) => {
      release = r;
    });
    const f = setup({ delayDecode });
    await f.seed();
    const off = f.listen();
    await pause(20);
    if (disconnect) f.cache.connectionChanged();
    f.set("thread", state([turn("live delta", "inProgress")], "resumed"));
    release();
    await pause(30);
    assert.equal(
      f.latest.value.itemsByKey['["turn:turn-one","message-one"]'].text,
      "live delta",
    );
    assert.equal(f.cache.diagnostics().hits, 0);
    off();
    f.dispose();
  }
});
test("cached presentation does not wait for metadata RPC or create a backend conversation", async () => {
  const f = setup();
  f.states.delete("thread");
  await f.seed();
  const off = f.listen();
  await until(() => f.cache.diagnostics().hits === 1);
  assert.equal(f.latest.value.resumeState, "needs_resume");
  assert.equal(
    f.latest.value.itemsByKey['["turn:turn-one","message-one"]'].text,
    "cached",
  );
  assert.equal(f.manager.getConversation("thread"), undefined);
  off();
  f.dispose();
});
test("re-enabling caching captures the currently open conversation without navigation", async () => {
  const f = setup();
  await f.cache.configure({ enabled: false });
  const off = f.listen();
  f.set("thread", state([turn("online")], "resumed"));
  await pause(30);
  assert.equal((await f.store.stats()).threads, 0);
  await f.cache.configure({ enabled: true });
  await until(() => f.cache.diagnostics().writes === 1);
  assert.equal((await f.store.stats()).threads, 1);
  off();
  f.dispose();
});
test("older cached pages only prepend a matching boundary while real pagination runs", async () => {
  let finish,
    started = false;
  const f = setup({
    configureManager(manager) {
      manager.loadOlderConversationTurnsPage = () => {
        started = true;
        return new Promise((resolve) => {
          finish = resolve;
        });
      };
    },
  });
  const turns = ["old", "boundary", "latest"].map((id) => ({
    ...turn(id),
    turnId: id,
  }));
  const pages = turns.map((t, i) =>
    m.encodePage(`${t.turnId}:page:0`, i, {
      schema: 1,
      turnId: t.turnId,
      offset: 0,
      total: 1,
      details: m.turnDetails(t),
      items: t.items,
      boundary: null,
    }),
  );
  const { ticket } = await f.store.readPages(f.key);
  await f.store.savePages(
    f.key,
    ticket,
    pages,
    pages.map((p) => p.id),
  );
  const live = {
    ...state(turns.slice(1), "resumed"),
    turnsPagination: { hasLoadedOldest: false },
  };
  f.states.set("thread", live);
  const off = f.listen();
  await pause(20);
  const loading = f.manager.loadOlderConversationTurnsPage("thread");
  assert.equal(started, true);
  await until(() => f.latest.value.turnEntityKeys.length === 3);
  assert.equal(f.manager.getConversation("thread").turns.length, 2);
  finish();
  await loading;
  assert.equal(f.latest.value.turnEntityKeys.length, 2);
  off();
  f.dispose();
});
test("identity is verified before cache access and account changes remove cached display", async () => {
  const f = setup();
  await f.seed();
  const off = f.listen();
  await until(() => f.cache.diagnostics().hits === 1);
  f.identity("account-two");
  assert.equal(f.cache.diagnostics().syncing, 0);
  assert.equal(f.latest.value.turnEntityKeys.length, 0);
  await pause(20);
  off();
  f.dispose();
  const unknown = setup({ identity: "" });
  await unknown.seed();
  const off2 = unknown.listen();
  await pause(30);
  assert.equal(unknown.cache.diagnostics().hits, 0);
  off2();
  unknown.dispose();
});
test("delete, rollback and authentication failure invalidate cached presentation", async () => {
  for (const invalidate of [
    (f) => f.emit("delete", "thread"),
    (f) => f.emit("thread/reverted", { params: { threadId: "thread" } }),
    (f) => f.emit("thread/compacted", { params: { threadId: "thread" } }),
    (f) => f.emit("auth", { authMethod: null }),
    (f) =>
      f.manager.applyRollbackResponseToConversation({
        conversationId: "thread",
        state: state([], "resumed"),
      }),
    (f) => f.cache.authenticationFailed(),
  ]) {
    const f = setup();
    await f.seed();
    const off = f.listen();
    await until(() => f.cache.diagnostics().hits === 1);
    invalidate(f);
    assert.equal(f.cache.diagnostics().syncing, 0);
    assert.equal(f.latest.value.turnEntityKeys.length, 0);
    off();
    f.dispose();
  }
});
test("stream snapshots coalesce and final completion immediately writes real final content", async () => {
  const f = setup();
  const off = f.listen();
  await pause(20);
  f.set("thread", state([turn("first", "inProgress")], "resumed"));
  await until(() => f.cache.diagnostics().writes === 1);
  for (let i = 0; i < 20; i++)
    f.set("thread", state([turn(String(i), "inProgress")], "resumed"));
  await pause(30);
  assert.equal(f.cache.diagnostics().writes, 1);
  f.set("thread", state([turn("final")], "resumed"));
  f.emit("complete", { conversationId: "thread" });
  await until(() => f.cache.diagnostics().writes === 2);
  const saved = await f.store.readPages(f.key);
  assert.equal(m.decodePage(saved.pages[0]).items[0].text, "final");
  off();
  f.dispose();
});
test("navigation keeps a running turn observable and saves its final snapshot", async () => {
  const f = setup();
  const off = f.listen();
  await pause(20);
  f.set(
    "thread",
    state([turn("stream before navigation", "inProgress")], "resumed"),
  );
  await until(() => f.cache.diagnostics().writes === 1);
  off();
  await pause(20);
  f.set("thread", state([turn("final after navigation")], "resumed"));
  f.emit("complete", { conversationId: "thread" });
  await until(() => f.cache.diagnostics().writes === 2);
  const saved = await f.store.readPages(f.key);
  assert.equal(
    m.decodePage(saved.pages[0]).items[0].text,
    "final after navigation",
  );
  f.dispose();
});
test("rapid native subscription replacement does not fence the next writer", async () => {
  const f = setup();
  for (let i = 0; i < 5; i++) {
    const off = f.listen();
    await pause(5);
    off();
  }
  const off = f.listen();
  f.set(
    "thread",
    state([turn("history before backend resume")], "needs_resume"),
  );
  await until(() => f.cache.diagnostics().writes > 0);
  const saved = await f.store.readPages(f.key);
  assert.equal(
    m.decodePage(saved.pages[0]).items[0].text,
    "history before backend resume",
  );
  assert.equal(f.manager.getConversation("thread").resumeState, "needs_resume");
  off();
  f.dispose();
});
test("reconnection during a cache read reacquires a ticket and persists fresh native history", async () => {
  let release;
  const delayDecode = new Promise((r) => {
    release = r;
  });
  const f = setup({ delayDecode });
  await f.seed();
  const off = f.listen();
  await pause(20);
  f.cache.connectionChanged();
  f.set("thread", state([turn("new connection history")], "resumed"));
  release();
  await until(() => f.cache.diagnostics().writes > 0);
  const saved = await f.store.readPages(f.key);
  assert.equal(
    m.decodePage(saved.pages[0]).items[0].text,
    "new connection history",
  );
  assert.equal(f.cache.diagnostics().hits, 0);
  off();
  f.dispose();
});
