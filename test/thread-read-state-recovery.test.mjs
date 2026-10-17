import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { nativeAppHostRuntime } from "./desktop-app-host-harness.mjs";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const shared = await readFile(
  "scratch/asar/webview/assets/app-shared-8340f229c2b3.js",
  "utf8",
);
const initial = await readFile(
  "scratch/asar/webview/assets/app-initial-1ab6fbe93c4f.js",
  "utf8",
);
const { AppHostRecovery } = await importTypescriptModule(
  "src/browser/app-host-recovery.ts",
);
const rpc = await nativeAppHostRuntime();
const hostId = "remote-ssh-discovered:read-state-test";
const threadId = "read-state-test-side-chat";
const identity = {
  kind: "chatgpt",
  accountId: "test-account",
  userId: "test-user",
};
const noop = () => {};
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  for (let i = 0; i < 12; i++) await tick();
}
function between(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `pinned Desktop ${start} must exist`);
  return source.slice(first, last);
}
function readStateRuntime(extra = {}) {
  const code = between(shared, "uKt=class", "},dR=new uKt").slice(4) + "}";
  const helpers =
    between(shared, "function dyt(", "function ") +
    between(shared, "function cKt(", "function ") +
    between(shared, "function cR(", "var lR");
  let epoch = 0;
  const context = {
    Error,
    Map,
    Set,
    Symbol,
    crypto: { randomUUID: () => `test-epoch-${++epoch}` },
    window: { localStorage: { removeItem: noop } },
    GI: () => ({ u: (value) => value, d: noop }),
    YRt: () => ({}),
    wI: "test:",
    lR: "read-state",
    uR: "status",
    Vu: () => ({ safeParse: () => ({}) }),
    z: noop,
    V: noop,
    Hf: { subscribe: () => noop },
    zf: { warning: noop },
    Y: String,
    ...extra,
  };
  // The native RPC serializer checks the realm's Function prototype. Compile in
  // this realm so the store's real open callback can cross a real MessagePort.
  return new Function(...Object.keys(context), `${helpers}; return (${code});`)(
    ...Object.values(context),
  );
}
function provider() {
  const entries = [];
  const writes = [];
  const state = {
    identity,
    keys: { [hostId]: "test-execution-key" },
    unread: { [hostId]: [threadId] },
  };
  return {
    entries,
    writes,
    state,
    getExecutionHostKeys: async () => state.keys,
    async open(callback) {
      const entry = { callback, disposed: false, writes: [], logoutCalls: 0 };
      entries.push(entry);
      const snapshot = {
        status: "ready",
        identity: state.identity,
        executionHostKeysByHostId: state.keys,
        unreadThreadIdsByHostId: state.unread,
        session: {
          async set(update) {
            entry.writes.push(update);
            writes.push(update);
            return { status: "ok" };
          },
          async clearForLogout() {
            entry.logoutCalls++;
          },
        },
        [Symbol.dispose]() {
          entry.disposed = true;
        },
      };
      entry.snapshot = snapshot;
      return snapshot;
    },
  };
}
async function initializedReadState(t, source = provider()) {
  const Read = readStateRuntime();
  const read = new Read();
  t.after(() => read.dispose());
  await read.initialize(source);
  await read.refresh();
  return { read, source };
}

function nativeEnvironment(t, { blockKeys = false, blockOpen = false } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const warnings = [];
  const Read = readStateRuntime({
    zf: {
      warning: (message, data) =>
        warnings.push([message, String(data?.sensitive?.error)]),
    },
  });
  const read = new Read();
  let disposals = 0;
  let transportDisconnects = 0;
  const disconnectTransport = read.disconnectTransport.bind(read);
  read.disconnectTransport = () => {
    transportDisconnects++;
    return disconnectTransport();
  };
  const dispose = read.dispose.bind(read);
  read.dispose = () => {
    disposals++;
    dispose();
  };
  const writes = [];
  let opens = 0;
  let keyReads = 0;
  let releaseKeys;
  let releaseOpen;
  class ReadSession extends rpc.Target {
    set(update) {
      writes.push(update);
      return { status: "ok" };
    }
    unsubscribe() {}
    clearForLogout() {}
  }
  class ReadProvider extends rpc.Target {
    getExecutionHostKeys() {
      if (++keyReads === 1 && blockKeys)
        return new Promise((resolve) => {
          releaseKeys = () => resolve({ [hostId]: "obsolete-execution-key" });
        });
      return { [hostId]: "test-execution-key" };
    }
    open(callback) {
      opens++;
      const retained = callback.dup();
      const session = new ReadSession();
      retained.onRpcBroken(() => session.unsubscribe());
      const snapshot = {
        status: "ready",
        identity,
        executionHostKeysByHostId: { [hostId]: "test-execution-key" },
        unreadThreadIdsByHostId: { [hostId]: [threadId] },
        session,
      };
      if (opens === 1 && blockOpen)
        return new Promise((resolve) => {
          releaseOpen = () => resolve(snapshot);
        });
      return snapshot;
    }
  }
  class PeerRoot extends rpc.Target {
    get services() {
      return {
        threadReadState: new ReadProvider(),
        settings: new (class extends rpc.Target {
          readAll() {
            return { values: {}, configuredValues: {} };
          }
        })(),
        startup: new (class extends rpc.Target {
          whenReady() {}
        })(),
      };
    }
  }
  const channels = [];
  const peers = [];
  let latestPeerPort;
  const coordinator = new AppHostRecovery();
  const window = {
    location: { origin: "https://read-state.invalid" },
    postMessage({ port }) {
      channels.push(port);
      latestPeerPort = port;
      peers.push(rpc.connect(port, new PeerRoot()));
    },
    __ELECTRON_SHIM__: {
      appHost: coordinator,
      configureAppHost(factory) {
        coordinator.configure(factory);
        return coordinator.start();
      },
      wrapBrowserServices: (services) => services,
    },
  };
  const root = between(shared, "Bli=class extends vF", ",Vli=new Bli").slice(4);
  const connect = between(shared, "function Uli(", "function Wli(");
  const configure = between(shared, "async function qli(", "var $3,");
  const runtime = vm.runInNewContext(
    `let $3,e6,readStateRecoveryCleanup; const Bli=(${root}),Vli=new Bli({}); ${connect}; ${configure}; ({ configure:qli })`,
    {
      Symbol,
      vF: rpc.Target,
      dR: read,
      MessageChannel,
      nIt(port, target) {
        channels.push(port);
        const peer = rpc.connect(port, target);
        peers.push(peer);
        return peer;
      },
      window,
      Gli: () => noop,
      ZWt: noop,
      hii: noop,
      yGt: noop,
    },
  );
  t.after(() => {
    releaseKeys?.();
    releaseOpen?.();
    coordinator.authenticationFailed();
    for (const peer of peers) peer[Symbol.dispose]();
    for (const port of channels) port.close();
    read.dispose();
  });
  return {
    read,
    coordinator,
    runtime,
    warnings,
    writes,
    get opens() {
      return opens;
    },
    get keyReads() {
      return keyReads;
    },
    get disposals() {
      return disposals;
    },
    get transportDisconnects() {
      return transportDisconnects;
    },
    disconnect: () => latestPeerPort.postMessage(null),
    releaseKeys: () => releaseKeys?.(),
    releaseOpen: () => releaseOpen?.(),
  };
}

test("real AppHost reconnect preserves the renderer read-state lifetime and closes a side chat", async (t) => {
  const env = nativeEnvironment(t);
  await env.runtime.configure();
  await env.read.refresh();
  const handle = env.read.forHost(hostId);
  handle.set(threadId, false);
  await settle();
  assert.equal(env.opens, 1, JSON.stringify(env.warnings));
  assert.equal(env.writes.length, 1, JSON.stringify(env.warnings));

  // Use the transport's real remote-close sentinel. Do not dispose the store
  // directly: the regression was native RPC disposing its shared renderer root.
  for (let reconnect = 1; reconnect <= 2; reconnect++) {
    env.disconnect();
    await settle();
    assert.equal(
      env.disposals,
      0,
      "closing one RPC session must not dispose page read state",
    );
    await env.coordinator.recover();
    await settle();
    await env.read.refresh();
    assert.equal(
      env.opens,
      reconnect + 1,
      "the new transport must reopen its read-state session",
    );
    assert.doesNotThrow(() => handle.set(threadId, false));
    await settle();
    assert.equal(env.writes.length, reconnect + 1);
  }
  await closeSideChat(handle);
});

test("AppHost reconnect during initial host-key loading completes initialization with the new host keys", async (t) => {
  const env = nativeEnvironment(t, { blockKeys: true });
  const configured = env.runtime.configure();
  await settle();
  assert.equal(env.keyReads, 1);
  env.disconnect();
  await settle();
  const recovery = env.coordinator.recover();
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  await recovery;
  await configured;
  await env.read.refresh();
  assert.equal(
    env.keyReads,
    2,
    "replay only the safe host-key read on the new RPC session",
  );
  assert.equal(env.read.executionHostKey(hostId), "test-execution-key");
  assert.doesNotThrow(() => env.read.forHost(hostId).set(threadId, false));
  env.releaseKeys();
  await settle();
  assert.equal(env.read.executionHostKey(hostId), "test-execution-key");
  assert.equal(env.disposals, 0);
});

test("pending read-state open does not block AppHost initialization and can recover on a new transport", async (t) => {
  const env = nativeEnvironment(t, { blockOpen: true });
  let configured = false;
  const ready = env.runtime.configure().then(() => {
    configured = true;
  });
  await settle();
  assert.equal(env.opens, 1);
  assert.equal(
    configured,
    true,
    "auxiliary read-state opening cannot block initial page readiness",
  );
  await ready;
  env.disconnect();
  await settle();
  await env.coordinator.recover();
  await env.read.refresh();
  assert.equal(env.opens, 2);
  env.releaseOpen();
  await settle();
  assert.doesNotThrow(() => env.read.forHost(hostId).set(threadId, false));
  assert.equal(env.disposals, 0);
});

test("retrying AppHost initialization replaces its read-state recovery hooks", async (t) => {
  const env = nativeEnvironment(t);
  await env.runtime.configure();
  await env.read.refresh();
  await env.runtime.configure();
  await env.read.refresh();
  const before = env.transportDisconnects;
  env.disconnect();
  await settle();
  assert.equal(env.transportDisconnects - before, 1);
  await env.coordinator.recover();
  await env.read.refresh();
  assert.doesNotThrow(() => env.read.forHost(hostId).set(threadId, false));
});

test("read-state disconnect buffers cleanup without writing the retired session or accepting old events", async (t) => {
  const { read, source } = await initializedReadState(t);
  const handle = read.forHost(hostId);
  const changes = [];
  handle.subscribe((event) => changes.push(event));
  const old = source.entries[0];
  read.disconnectTransport();
  assert.equal(old.disposed, true);
  assert.equal(
    read.read()[hostId][0],
    threadId,
    "retain the last visible snapshot",
  );
  assert.doesNotThrow(() => handle.set(threadId, false));
  assert.equal(
    old.writes.length,
    0,
    "offline cleanup cannot write a retired RPC session",
  );
  old.callback({
    type: "changed",
    hostId,
    threadId: "late-old-event",
    hasUnreadTurn: true,
    origin: "external",
  });
  old.callback({ type: "retired", reason: "identity" });
  assert.equal(read.read()[hostId].includes("late-old-event"), false);
  assert.equal(changes.length, 0);

  await read.reconnectTransport();
  await read.refresh();
  assert.equal(source.entries.length, 2);
  assert.equal(handle.isReady(), true);
  assert.equal(
    handle.has(threadId),
    false,
    "apply buffered read-state cleanup after reconnect",
  );
  assert.equal(old.writes.length, 0);
  assert.equal(source.entries[1].writes.at(-1).hasUnreadTurn, false);
});

test("late read-state open cannot replace the new transport session", async (t) => {
  const source = provider();
  const open = source.open.bind(source);
  let resolveOld;
  source.open = async (callback) => {
    const snapshot = await open(callback);
    if (source.entries.length !== 1) return snapshot;
    return new Promise((resolve) => {
      resolveOld = () => resolve(snapshot);
    });
  };
  const Read = readStateRuntime();
  const read = new Read();
  t.after(() => {
    resolveOld?.();
    read.dispose();
  });
  await read.initialize(source);
  await settle();
  const oldRefresh = read.refresh();
  const handle = read.forHost(hostId);
  read.disconnectTransport();
  const reconnect = read.reconnectTransport();
  await settle();
  assert.equal(
    source.entries.length,
    2,
    "a stale pending open cannot block the new transport",
  );
  await reconnect;
  await read.refresh();
  source.entries[0].callback({ type: "retired", reason: "identity" });
  resolveOld();
  await oldRefresh;
  await settle();
  assert.equal(source.entries[0].disposed, true);
  handle.set(threadId, false);
  assert.equal(source.entries[0].writes.length, 0);
  assert.equal(source.entries[1].writes.length, 1);
});

test("an old open finalizer cannot clear a newer pending open and start a third session", async (t) => {
  const source = provider();
  const open = source.open.bind(source);
  const releases = [];
  source.open = async (callback) => {
    const snapshot = await open(callback);
    return new Promise((resolve) => {
      releases.push(() => resolve(snapshot));
    });
  };
  const Read = readStateRuntime();
  const read = new Read();
  t.after(() => {
    for (const release of releases) release();
    read.dispose();
  });
  await read.initialize(source);
  await settle();
  const oldRefresh = read.refresh();
  read.disconnectTransport();
  const reconnect = read.reconnectTransport();
  await settle();
  assert.equal(source.entries.length, 2);
  const currentRefresh = read.refresh();
  releases[0]();
  await oldRefresh;
  await settle();
  assert.equal(
    read.refresh(),
    currentRefresh,
    "keep the new in-flight open after the old finally runs",
  );
  assert.equal(source.entries.length, 2);
  releases[1]();
  await reconnect;
  await currentRefresh;
  assert.doesNotThrow(() => read.forHost(hostId).set(threadId, false));
  assert.equal(source.entries[0].writes.length, 0);
  assert.equal(source.entries[1].writes.length, 1);
});

test("real logout invalidates old handles while a new account can reopen read state", async (t) => {
  const { read, source } = await initializedReadState(t);
  const old = source.entries[0];
  const handle = read.forHost(hostId);
  read.clearForLogout();
  assert.throws(
    () => handle.set(threadId, false),
    /Thread read state is unavailable/,
  );
  await settle();
  assert.equal(old.logoutCalls, 1);
  assert.equal(old.disposed, true);
  source.state.identity = { ...identity, accountId: "new-login-account" };
  await read.refresh();
  const fresh = read.forHost(hostId);
  assert.doesNotThrow(() => fresh.set(threadId, false));
  assert.throws(
    () => handle.set(threadId, false),
    /Thread read state is unavailable/,
  );
  assert.equal(source.entries.length, 2);
  assert.equal(old.writes.length, 0);
});

test("initial host keys arriving after reconnect cannot overwrite the recovered snapshot", async (t) => {
  const source = provider();
  let resolveKeys;
  source.getExecutionHostKeys = () =>
    new Promise((resolve) => {
      resolveKeys = resolve;
    });
  const Read = readStateRuntime();
  const read = new Read();
  t.after(() => {
    resolveKeys?.({ [hostId]: "stale-key" });
    read.dispose();
  });
  const initialize = read.initialize(source);
  read.disconnectTransport();
  source.state.keys = { [hostId]: "reconnected-key" };
  await read.reconnectTransport();
  await read.refresh();
  assert.equal(read.executionHostKey(hostId), "reconnected-key");
  const handle = read.forHost(hostId);
  resolveKeys({ [hostId]: "stale-key" });
  await initialize;
  assert.equal(read.executionHostKey(hostId), "reconnected-key");
  assert.doesNotThrow(() => handle.set(threadId, false));
});

test("missing host keys arriving from an old transport cannot register a stale host", async (t) => {
  const { read, source } = await initializedReadState(t);
  const otherHost = "remote-ssh-discovered:old-only-host";
  let resolveKeys;
  source.getExecutionHostKeys = () =>
    new Promise((resolve) => {
      resolveKeys = resolve;
    });
  const refresh = read.refreshMissingHostKeys([otherHost]);
  read.disconnectTransport();
  await read.reconnectTransport();
  await read.refresh();
  resolveKeys({ ...source.state.keys, [otherHost]: "stale-key" });
  await refresh;
  assert.equal(read.executionHostKey(otherHost), undefined);
  assert.equal(source.entries.length, 2);
});

for (const changed of ["identity", "host"]) {
  test(`transport recovery still rejects handles after a real ${changed} change`, async (t) => {
    const { read, source } = await initializedReadState(t);
    const handle = read.forHost(hostId);
    handle.subscribe(noop);
    read.disconnectTransport();
    handle.set(threadId, false);
    if (changed === "identity")
      source.state.identity = { ...identity, accountId: "different-account" };
    else source.state.keys = { [hostId]: "different-execution-key" };
    await read.reconnectTransport();
    await read.refresh();
    assert.equal(
      source.writes.length,
      0,
      "do not migrate queued writes to a different identity or host",
    );
    assert.throws(
      () => handle.set(threadId, false),
      /Thread read state is unavailable/,
    );
    assert.doesNotThrow(() => read.forHost(hostId).set(threadId, false));
  });
}

async function closeSideChat(readState) {
  const trace = [];
  let tab;
  let reopened = false;
  const panel = {
    panelId: "right",
    tabs$: "tabs",
    tabById$: "tab",
    async openPendingTab() {
      return {
        complete(_kind, value) {
          tab = value;
          return true;
        },
        isCurrent: () => true,
        fail: noop,
      };
    },
    openTab() {
      reopened = true;
    },
  };
  const scope = {
    value: { pathname: "/thread/test-parent" },
    get(key) {
      if (key === "enabled") return true;
      if (key === "tabs") return [];
      if (key === "voice") return { phase: "inactive" };
      if (key === "tab") return { contentInstance: 1 };
      return null;
    },
    set: noop,
  };
  const record = (name) => () => trace.push(name);
  const evictCode = between(shared, "r4t=class", "var a4t")
    .slice(4)
    .split("}))()}")[0];
  const discardCode = between(
    shared,
    "async discardConversationFromCache(e){",
    "ensureRecentConversationId(e)",
  );
  const saveCode = between(
    shared,
    "saveReadState(e,t,n){",
    "applySavedConversationReadState(e,t){",
  );
  const manager = {
    hostId,
    readState,
    runtime: { threadMode: () => "local" },
    threadStore: { isEphemeralConversation: () => true },
    getConversation: () => ({}),
    sendRequest: async (method) => {
      trace.push(method);
      return { status: "notLoaded" };
    },
    logger: { warning: noop },
  };
  const api = vm.runInNewContext(
    `${between(initial, "async function Sks(", "var Dks")}; ${between(shared, "async function dan(", "function fan(")}; ({open:Sks,Evict:(${evictCode}),discard:({${discardCode}}).discardConversationFromCache,save:({${saveCode}}).saveReadState})`,
    {
      Error,
      Symbol,
      setTimeout,
      clearTimeout,
      xOs: noop,
      Sj: "enabled",
      iVe: "archived",
      LWa: "deleted",
      NP: () => panel,
      h6: { dropDestinations: ["right"] },
      jks: {},
      kks: "sidechat-loading:",
      Oks: { jsx: noop },
      Ri: "settings",
      oQe: "model",
      OOe: () => ({}),
      QOs: async () => ({ conversationId: threadId, hostId }),
      sW: "sidechat:",
      hks: noop,
      mks: noop,
      WTi: "durable",
      m9n: noop,
      h9n: record("parent.unlink"),
      yks: () => noop,
      jl: "voice",
      Cq: "voice-transfer",
      vna: () => false,
      Pd: { realtimeVoiceHistory: { forgetEphemeral: async () => {} } },
      lf: record("discard.event"),
      TOs: "discard",
      gr: { warning: (message) => trace.push(message) },
      Fz: () => false,
      az: 15000,
      OP: (error) => error.code,
      Dg: () => manager,
    },
  );
  manager.saveReadState = api.save;
  manager.discardConversationFromCache = api.discard;
  manager.conversationCacheEvictor = new api.Evict({
    clearPersistedUnreadState: (id) => manager.saveReadState(id, false),
    invalidateResumeState: noop,
    inactiveThreadUnsubscriber: { removeConversation: noop },
    itemStreamState: { clearConversationTerminalInputBuffers: noop },
    manualContextCompactions: { clearConversation: noop },
    unread: { clearConversation: noop },
    resumeNotificationBuffer: { discard: noop },
    threadStartedNotificationDeferral: { discardConversation: noop },
    threadStore: {
      removeConversationStoreEntries: record("cache.evict"),
      removeThreadSummary: noop,
    },
  });
  await api.open(scope, noop, {
    sourceConversationId: "test-parent",
    hostId,
    displayTitle: "Test side chat",
    intl: {},
  });
  tab.onClose();
  await settle();
  assert.equal(
    reopened,
    false,
    "successful side-chat close must not recreate the tab",
  );
  assert.deepEqual(trace, [
    "thread/unsubscribe",
    "cache.evict",
    "discard.event",
    "parent.unlink",
  ]);
}
