import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const {
  configureStatsigClient,
  snapshotKey,
  parseSnapshot,
  targetingIdentity,
  STATSIG_CACHE_TTL_MS,
  STATSIG_CACHE_ENTRY_MAX_BYTES,
  STATSIG_STARTUP_TIMEOUT_MS,
} = await importTypescriptModule("src/browser/statsig-cache.ts");
const BUILD = "26.901-test";
const SDK = "client-test-sdk";
const payload = {
  has_updates: true,
  feature_gates: { feature: { value: true } },
  dynamic_configs: {},
  layer_configs: {},
};
const user = {
  userID: "one",
  customIDs: { account_id: "a", stableID: "s" },
  custom: {
    auth_method: "apikey",
    codex_app_session_id: "session-one",
    desktop_app_beta_enabled: false,
  },
};

function fixture(overrides = {}) {
  const clock = { value: Date.now() - 10_000 };
  const records = new Map();
  const store = {
    async get(key) {
      return records.get(key);
    },
    async put(value) {
      records.set(value.key, value);
    },
    async delete(key) {
      records.delete(key);
    },
    async clear() {
      records.clear();
    },
    ...overrides,
  };
  const scheduled = [];
  const marks = [];
  const deps = {
    store,
    now: () => clock.value,
    schedule: (fn) => scheduled.push(fn),
    mark: (event) => marks.push(event),
  };
  return { clock, records, store, scheduled, marks, deps };
}

function fakeClient(f, initialUser = structuredClone(user)) {
  const listeners = new Map();
  let data;
  const client = {
    user: initialUser,
    values: undefined,
    loadingStatus: "Uninitialized",
    networkCalls: 0,
    refreshCalls: 0,
    failRefresh: false,
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    getContext() {
      return { user: structuredClone(this.user), values: this.values };
    },
    dataAdapter: {
      getDataSync() {
        return data;
      },
      setData(raw, current) {
        assert.deepEqual(current, client.user);
        data = { data: raw, source: "Bootstrap", receivedAt: f.clock.value };
        client.values = JSON.parse(raw);
      },
    },
    async initializeAsync() {
      this.networkCalls++;
      this.loadingStatus = "Ready";
      this.values = structuredClone(payload);
      data = {
        source: "Network",
        data: JSON.stringify(payload),
        receivedAt: f.clock.value,
      };
      this.emit("values_updated");
      return { success: true };
    },
    initializeSync() {
      this.loadingStatus = "Ready";
      this.emit("values_updated");
      return { success: true };
    },
    async refreshValuesAsync() {
      this.refreshCalls++;
      if (this.failRefresh) throw new Error("offline");
      data = {
        source: "NetworkNotModified",
        data: JSON.stringify(payload),
        receivedAt: f.clock.value,
      };
      this.emit("values_updated");
      return { success: true };
    },
  };
  return client;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
async function prime(f) {
  const key = await snapshotKey(SDK, BUILD, user);
  const raw = JSON.stringify(payload);
  await f.store.put({
    schema: 1,
    key,
    savedAt: f.clock.value,
    payload: raw,
    bytes: Buffer.byteLength(raw),
  });
  return key;
}

test("cache identity excludes only startup session id; isolates users, accounts, SDK and builds", async () => {
  const nextSession = structuredClone(user);
  nextSession.custom.codex_app_session_id = "session-two";
  assert.equal(targetingIdentity(nextSession), targetingIdentity(user));
  const key = await snapshotKey(SDK, BUILD, user);
  assert.equal(await snapshotKey(SDK, BUILD, nextSession), key);
  for (const other of [
    { ...user, userID: "other" },
    { ...user, customIDs: { account_id: "other" } },
    { ...user, locale: "zh-CN" },
    { ...user, custom: { ...user.custom, auth_method: "chatgpt" } },
  ]) {
    assert.notEqual(await snapshotKey(SDK, BUILD, other), key);
  }
  assert.notEqual(await snapshotKey("different-sdk", BUILD, user), key);
  assert.notEqual(await snapshotKey(SDK, "different-build", user), key);
});

test("cold startup fetches once and saves a network-validated snapshot", async () => {
  const f = fixture();
  const client = configureStatsigClient(fakeClient(f), SDK, BUILD, f.deps);
  const a = client.initializeAsync();
  const b = client.initializeAsync();
  assert.equal(a, b);
  await a;
  await tick();
  assert.equal(client.networkCalls, 1);
  assert.equal(f.records.size, 1);
  assert.deepEqual(f.marks, ["cache-miss", "ready"]);
});

test("cold startup bounds the SDK wait and preserves caller options and shorter deadlines", async () => {
  for (const [timeoutMs, expected] of [
    [undefined, STATSIG_STARTUP_TIMEOUT_MS],
    [30_000, STATSIG_STARTUP_TIMEOUT_MS],
    [250, 250],
    [0, STATSIG_STARTUP_TIMEOUT_MS],
    [NaN, STATSIG_STARTUP_TIMEOUT_MS],
  ]) {
    const f = fixture();
    const client = fakeClient(f);
    const initialize = client.initializeAsync.bind(client);
    let received;
    client.initializeAsync = (options) => {
      received = options;
      return initialize(options);
    };
    configureStatsigClient(client, SDK, BUILD, f.deps);
    await client.initializeAsync({ timeoutMs, priority: "low" });
    assert.deepEqual(received, { timeoutMs: expected, priority: "low" });
    assert.equal(client.loadingStatus, "Ready");
    assert.equal(f.scheduled.length, 0);
  }
});

test("unavailable feature config releases startup with SDK defaults and refreshes off the critical path", async () => {
  const f = fixture();
  const client = fakeClient(f);
  client.initializeAsync = async () => {
    client.loadingStatus = "Ready";
    return { success: false, source: "NoValues" };
  };
  configureStatsigClient(client, SDK, BUILD, f.deps);
  assert.deepEqual(await client.initializeAsync(), {
    success: false,
    source: "NoValues",
  });
  assert.equal(client.values, undefined, "never manufacture feature grants");
  assert.equal(client.refreshCalls, 0);
  assert.deepEqual(f.marks, ["cache-miss", "network-deferred", "ready"]);
  assert.equal(f.scheduled.length, 1);
  f.scheduled[0]();
  await tick();
  assert.equal(client.refreshCalls, 1);
  assert.equal(
    f.records.size,
    1,
    "background network data can populate the cache",
  );
});

test("failed cold startup never refreshes after shutdown or an account switch", async () => {
  for (const shutdown of [false, true]) {
    const f = fixture();
    const client = fakeClient(f);
    client.initializeAsync = async () => ({ success: false });
    configureStatsigClient(client, SDK, BUILD, f.deps);
    await client.initializeAsync();
    if (shutdown) client.emit("client_shutdown");
    else client.user = { ...user, userID: "other" };
    f.scheduled[0]();
    await tick();
    assert.equal(client.refreshCalls, 0);
  }
});

test("valid snapshot starts without network and restores current session metadata", async () => {
  const f = fixture();
  const key = await prime(f);
  const savedAt = f.records.get(key).savedAt;
  f.clock.value += 1000;
  const nextUser = structuredClone(user);
  nextUser.custom.codex_app_session_id = "next-session";
  const client = configureStatsigClient(
    fakeClient(f, nextUser),
    SDK,
    BUILD,
    f.deps,
  );
  await client.initializeAsync();
  await tick();
  assert.equal(client.networkCalls, 0);
  assert.equal(client.refreshCalls, 0);
  assert.deepEqual(client.values.user, nextUser);
  assert.deepEqual(f.marks, ["cache-hit", "ready"]);
  assert.equal(
    f.records.get(key).savedAt,
    savedAt,
    "bootstrap must not extend TTL",
  );
  assert.equal(f.scheduled.length, 1);
  f.scheduled[0]();
  await tick();
  assert.equal(client.refreshCalls, 1);
  assert.equal(f.records.get(key).savedAt, f.clock.value);
});

test("a stalled snapshot write never delays successful cold initialization", async () => {
  const f = fixture({ put: () => new Promise(() => {}) });
  const client = configureStatsigClient(fakeClient(f), SDK, BUILD, f.deps);
  const result = await Promise.race([
    client.initializeAsync(),
    new Promise((resolve) => setTimeout(() => resolve("stalled"), 200)),
  ]);
  assert.notEqual(result, "stalled");
  assert.equal(client.loadingStatus, "Ready");
});

test("background failure retains the snapshot and original expiry", async () => {
  const f = fixture();
  const key = await prime(f);
  const original = structuredClone(f.records.get(key));
  f.clock.value += 1000;
  const client = configureStatsigClient(fakeClient(f), SDK, BUILD, f.deps);
  client.failRefresh = true;
  await client.initializeAsync();
  f.scheduled[0]();
  await tick();
  assert.equal(client.loadingStatus, "Ready");
  assert.deepEqual(f.records.get(key), original);
});

test("expired or corrupt snapshots fall back to original initialization", async () => {
  for (const corrupt of [false, true]) {
    const f = fixture();
    const key = await prime(f);
    if (corrupt) f.records.get(key).payload = "not json";
    else f.clock.value += STATSIG_CACHE_TTL_MS;
    const client = configureStatsigClient(fakeClient(f), SDK, BUILD, f.deps);
    await client.initializeAsync();
    assert.equal(client.networkCalls, 1);
  }
});

test("storage denial or a stalled read cannot permanently block startup", async () => {
  for (const get of [
    async () => {
      throw new Error("denied");
    },
    () => new Promise(() => {}),
  ]) {
    const f = fixture({ get });
    const client = configureStatsigClient(fakeClient(f), SDK, BUILD, f.deps);
    await client.initializeAsync();
    assert.equal(client.networkCalls, 1);
  }
});

test("targeting change during cache lookup never applies the old snapshot", async () => {
  const f = fixture();
  const key = await prime(f);
  let finish;
  f.store.get = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const client = configureStatsigClient(fakeClient(f), SDK, BUILD, f.deps);
  const promise = client.initializeAsync();
  await tick();
  client.user = { ...user, userID: "other" };
  finish(f.records.get(key));
  await promise;
  assert.equal(client.networkCalls, 1);
  assert.equal(f.scheduled.length, 0);
});

test("deferred refresh does not run after account switch or shutdown", async () => {
  for (const shutdown of [false, true]) {
    const f = fixture();
    await prime(f);
    const client = configureStatsigClient(fakeClient(f), SDK, BUILD, f.deps);
    await client.initializeAsync();
    if (shutdown) client.emit("client_shutdown");
    else client.user = { ...user, userID: "different" };
    f.scheduled[0]();
    await tick();
    assert.equal(client.refreshCalls, 0);
  }
});

test("snapshot schema, timestamp and byte bounds are validated", async () => {
  const f = fixture();
  const key = await prime(f);
  const valid = f.records.get(key);
  assert.ok(parseSnapshot(valid, key, f.clock.value));
  for (const change of [
    { schema: 2 },
    { key: "other" },
    { savedAt: f.clock.value + 1 },
    { savedAt: NaN },
    { bytes: -1 },
    { bytes: valid.bytes - 1 },
    { bytes: STATSIG_CACHE_ENTRY_MAX_BYTES + 1 },
  ]) {
    assert.equal(
      parseSnapshot({ ...valid, ...change }, key, f.clock.value),
      null,
    );
  }
});
