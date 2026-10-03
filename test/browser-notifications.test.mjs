import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const {
  BrowserNotificationsController,
  IndexedDbNotificationLedger,
  notificationNavigationPath,
} = await importTypescriptModule("src/browser/notifications.ts");

const completion = (overrides = {}) => ({
  id: 'turn-["account","user","remote-test","thread-1","turn-1"]',
  title: "代码检查",
  hostId: "remote-test",
  conversationId: "thread-1",
  turnId: "turn-1",
  navigationPath: "/local/thread-1?hostId=remote-test",
  turnMode: "unfocused",
  sound: "default",
  status: "completed",
  ...overrides,
});

function sharedEnvironment() {
  const storage = new Map();
  const claims = new Set();
  const channels = new Set();
  const messages = [];
  let counter = 0;
  return {
    messages,
    claims,
    storage,
    ledger: {
      async claim(id, effect) {
        await Promise.resolve();
        const key = JSON.stringify([id, effect]);
        if (claims.has(key)) return false;
        claims.add(key);
        return true;
      },
    },
    channel() {
      const listeners = new Set();
      const channel = {
        postMessage(message) {
          messages.push(structuredClone(message));
          for (const peer of channels) {
            if (peer === channel) continue;
            queueMicrotask(() => {
              for (const listener of peer.listeners)
                listener({ data: structuredClone(message) });
            });
          }
        },
        addEventListener(_, listener) {
          listeners.add(listener);
        },
        removeEventListener(_, listener) {
          listeners.delete(listener);
        },
        close() {
          channels.delete(channel);
          listeners.clear();
        },
        listeners,
      };
      channels.add(channel);
      return channel;
    },
    nextId() {
      return `tab-${++counter}`;
    },
  };
}

function page(shared = sharedEnvironment(), overrides = {}) {
  const events = {
    audio: [],
    contexts: [],
    notifications: [],
    routes: [],
    warnings: [],
    preview: [],
  };
  const state = {
    focused: false,
    permission: "granted",
    permissionRequests: 0,
    activity: undefined,
  };
  const createAudioContext = () => {
    const context = {
      state: "suspended",
      destination: {},
      gain: { gain: { value: -1 }, connect() {} },
      createGain() {
        return this.gain;
      },
      addEventListener() {},
      resume() {
        this.state = "running";
        events.audio.push("resume");
        return Promise.resolve();
      },
      close() {
        this.state = "closed";
        return Promise.resolve();
      },
      async decodeAudioData(bytes) {
        events.audio.push(["decode", [...new Uint8Array(bytes)]]);
        return { bytes };
      },
      createBufferSource() {
        return {
          connect(destination) {
            this.destination = destination;
          },
          disconnect() {},
          start() {
            events.audio.push([
              "start",
              this.buffer,
              this.destination.gain.value,
            ]);
          },
          stop() {},
        };
      },
    };
    events.contexts.push(context);
    return context;
  };
  const env = {
    now: () => 1000,
    randomId: () => shared.nextId(),
    supported: true,
    permission: () => state.permission,
    async requestPermission() {
      state.permissionRequests++;
      state.permission = "granted";
      return state.permission;
    },
    focused: () => state.focused,
    createNotification(title, options) {
      const notification = {
        title,
        options,
        close() {
          this.closed = true;
        },
      };
      events.notifications.push(notification);
      return notification;
    },
    createAudioContext,
    storage: {
      getItem: (key) => shared.storage.get(key) ?? null,
      setItem: (key, value) => shared.storage.set(key, value),
    },
    ledger: shared.ledger,
    channel: shared.channel(),
    // A macrotask allows realistic async BroadcastChannel replies before selection.
    wait: () => new Promise((resolve) => setImmediate(resolve)),
    listenActivity(callback) {
      state.activity = callback;
      return () => {
        state.activity = undefined;
      };
    },
    focus() {
      state.focused = true;
    },
    navigate(path, routeState) {
      events.routes.push({ path, state: routeState });
    },
    warn(message) {
      events.warnings.push(message);
    },
    ...overrides,
  };
  const controller = new BrowserNotificationsController(env);
  controller.setPreviewSound(async (sound, callback) => {
    events.preview.push(sound);
    return callback(new Uint8Array([82, 73, 70, 70]));
  });
  return { controller, events, state, env, shared };
}

const starts = (page) =>
  page.events.audio.filter(
    (event) => Array.isArray(event) && event[0] === "start",
  );
const settle = async () => {
  for (let index = 0; index < 4; index++)
    await new Promise((resolve) => setImmediate(resolve));
};

test("foreground completion chimes independently of the unfocused notification mode", async () => {
  const p = page();
  p.state.focused = true;
  await p.controller.unlockAudio();
  await p.controller.complete(completion());
  assert.equal(starts(p).length, 1);
  assert.equal(starts(p)[0][2], 0.3);
  assert.equal(p.events.notifications.length, 0);
  assert.equal(p.state.permissionRequests, 0);
  assert.equal(p.events.contexts.length, 1);
  assert.equal(p.controller.getState().audioState, "ready");
  p.controller.dispose();
});

test("sound and notification settings independently enable either effect", async () => {
  const p = page();
  await p.controller.unlockAudio();
  await p.controller.complete(
    completion({ id: "audio-only", turnMode: "off" }),
  );
  await p.controller.complete(
    completion({ id: "popup-only", sound: "none", turnMode: "always" }),
  );
  assert.equal(starts(p).length, 1);
  assert.equal(p.events.notifications.length, 1);
  assert.equal(p.events.notifications[0].options.silent, true);
  assert.equal(p.events.notifications[0].options.body, "AI 已完成。");
  p.controller.dispose();
});

test("permission denial does not consume or block audio, and no startup prompt runs", async () => {
  const p = page();
  p.state.permission = "denied";
  assert.equal(p.state.permissionRequests, 0);
  await p.controller.unlockAudio();
  await p.controller.complete(completion());
  assert.equal(starts(p).length, 1);
  assert.equal(p.events.notifications.length, 0);
  assert.equal(p.shared.claims.size, 1);
  assert.equal(await p.controller.requestPermission(), "denied");
  assert.equal(p.state.permissionRequests, 0);
  p.controller.dispose();
});

test("locked audio is not resumed on completion or replayed after a later unlock", async () => {
  const p = page();
  await p.controller.complete(completion({ turnMode: "off" }));
  assert.equal(p.events.contexts.length, 0);
  assert.equal(p.shared.claims.size, 0);
  await p.controller.unlockAudio();
  await p.controller.complete(completion({ turnMode: "off" }));
  assert.equal(starts(p).length, 0);
  await p.controller.complete(
    completion({ id: "next-live-turn", turnMode: "off" }),
  );
  assert.equal(starts(p).length, 1);
  p.controller.dispose();
});

test("two concurrent tabs produce one audio and one popup; reload retains deduplication", async () => {
  const shared = sharedEnvironment();
  const a = page(shared);
  const b = page(shared);
  await Promise.all([a.controller.unlockAudio(), b.controller.unlockAudio()]);
  await Promise.all([
    a.controller.complete(completion()),
    b.controller.complete(completion()),
  ]);
  await settle();
  assert.equal(starts(a).length + starts(b).length, 1);
  assert.equal(
    a.events.notifications.length + b.events.notifications.length,
    1,
  );
  assert.equal(shared.claims.size, 2);
  const refreshed = page(shared);
  await refreshed.controller.unlockAudio();
  await refreshed.controller.complete(completion());
  await settle();
  assert.equal(starts(refreshed).length, 0);
  assert.equal(refreshed.events.notifications.length, 0);
  for (const p of [a, b, refreshed]) p.controller.dispose();
});

test("an unlocked peer can sound for a locked stream owner without assistant text in the broadcast", async () => {
  const shared = sharedEnvironment();
  const owner = page(shared);
  const peer = page(shared);
  await peer.controller.unlockAudio();
  await owner.controller.complete(
    completion({ turnMode: "off", body: "SECRET ASSISTANT RESPONSE" }),
  );
  await settle();
  assert.equal(starts(owner).length, 0);
  assert.equal(starts(peer).length, 1);
  const sent = shared.messages.find((message) => message.type === "completed");
  assert.equal(Object.hasOwn(sent.input, "body"), false);
  assert.equal(JSON.stringify(sent).includes("SECRET"), false);
  assert.equal(sent.input.navigationPath, "/local/thread-1?hostId=remote-test");
  owner.controller.dispose();
  peer.controller.dispose();
});

test("presence exchange suppresses unfocused popups when another same-origin tab is focused", async () => {
  const shared = sharedEnvironment();
  const background = page(shared);
  const foreground = page(shared);
  foreground.state.focused = true;
  await foreground.controller.unlockAudio();
  await background.controller.complete(completion());
  await settle();
  assert.equal(starts(foreground).length, 1);
  assert.equal(
    background.events.notifications.length +
      foreground.events.notifications.length,
    0,
  );
  background.controller.dispose();
  foreground.controller.dispose();
});

test("different hosts sharing thread and turn IDs each alert, and failed turns stay silent", async () => {
  const p = page();
  await p.controller.unlockAudio();
  await p.controller.complete(
    completion({ id: "host-A/thread/turn", hostId: "host-A" }),
  );
  await p.controller.complete(
    completion({ id: "host-B/thread/turn", hostId: "host-B" }),
  );
  for (const status of ["failed", "interrupted", "inProgress"]) {
    await p.controller.complete(completion({ id: status, status }));
  }
  assert.equal(starts(p).length, 2);
  assert.equal(p.events.notifications.length, 2);
  assert.equal(
    p.shared.messages.filter((message) => message.type === "completed").length,
    2,
  );
  p.controller.dispose();
});

test("click calls the native open callback and preserves host and sidechat state without credentials", async () => {
  const p = page();
  const actions = [];
  await p.controller.complete(
    completion({ sound: "none", turnMode: "always" }),
    {
      async onOpen(action) {
        actions.push(action);
        return {
          path: "/local/parent-thread?token=private&hostId=wrong",
          state: { activateTabId: "sidechat:thread-1" },
        };
      },
    },
  );
  p.events.notifications[0].onclick();
  await settle();
  assert.deepEqual(actions, [{ id: null, type: "open" }]);
  assert.deepEqual(p.events.routes, [
    {
      path: "/local/parent-thread?hostId=remote-test",
      state: { activateTabId: "sidechat:thread-1" },
    },
  ]);
  assert.equal(p.events.notifications[0].closed, true);
  assert.equal(p.state.focused, true);
  p.controller.dispose();
});

test("a broadcast popup opens the remote sidechat with only whitelisted navigation state", async () => {
  const shared = sharedEnvironment();
  const owner = page(shared, { supported: false });
  const peer = page(shared);
  await owner.controller.complete(
    completion({
      sound: "none",
      turnMode: "always",
      navigationPath: "/local/parent-thread?hostId=remote-test",
      navigationState: {
        activateTabId: "sidechat:thread-1",
        activateTabFallbackPath: "/local/thread-1?hostId=remote-test",
        token: "PRIVATE TOKEN",
        reply: "PRIVATE REPLY",
      },
    }),
  );
  await settle();
  assert.equal(peer.events.notifications.length, 1);
  peer.events.notifications[0].onclick();
  await settle();
  assert.deepEqual(peer.events.routes, [
    {
      path: "/local/parent-thread?hostId=remote-test",
      state: { activateTabId: "sidechat:thread-1" },
    },
  ]);
  const sent = shared.messages.find((message) => message.type === "completed");
  assert.deepEqual(sent.input.navigationState, {
    activateTabId: "sidechat:thread-1",
  });
  assert.equal(JSON.stringify(sent).includes("PRIVATE"), false);
  owner.controller.dispose();
  peer.controller.dispose();
});

test("preview unlocks synchronously, caches native WAV decoding, and shares gain with playBytes", async () => {
  const p = page();
  const preview = p.controller.preview("default");
  assert.equal(p.events.contexts.length, 1);
  assert.equal(p.events.contexts[0].state, "running");
  assert.equal(await preview, true);
  p.controller.setVolume(0.6);
  assert.equal(await p.controller.preview("default"), true);
  await p.controller.complete(completion({ turnMode: "off" }));
  assert.equal(p.events.preview.length, 1);
  assert.equal(
    p.events.audio.filter(
      (event) => Array.isArray(event) && event[0] === "decode",
    ).length,
    1,
  );
  const bytes = new Uint8Array([0, 1, 2, 3, 4]);
  assert.equal(await p.controller.playBytes(bytes.subarray(1, 4)), true);
  assert.deepEqual(
    p.events.audio
      .filter((event) => Array.isArray(event) && event[0] === "decode")
      .at(-1)[1],
    [1, 2, 3],
  );
  assert.equal(starts(p).at(-1)[2], 0.6);
  assert.equal(p.events.contexts.length, 1);
  const reload = page(p.shared);
  assert.equal(reload.controller.getState().volume, 0.6);
  p.controller.dispose();
  reload.controller.dispose();
});

test("custom sounds are preserved and failed native WAV reads retry on the next live event", async () => {
  const p = page();
  const custom = { fileName: "codex-custom-hash.wav", name: "我的声音" };
  let attempts = 0;
  p.controller.setPreviewSound(async (sound, callback) => {
    attempts++;
    assert.equal(sound.fileName, custom.fileName);
    if (attempts === 1) throw Error("temporarily disconnected");
    return callback([82, 73, 70, 70]);
  });
  await p.controller.unlockAudio();
  await p.controller.complete(
    completion({ id: "first", sound: custom, turnMode: "off" }),
  );
  await p.controller.complete(
    completion({ id: "second", sound: custom, turnMode: "off" }),
  );
  assert.equal(attempts, 2);
  assert.equal(starts(p).length, 1);
  assert.equal(p.events.warnings.length, 1);
  assert.equal(p.controller.getState().error, undefined);
  p.controller.dispose();
});

test("aborted late WAV reads never claim or play an effect", async () => {
  const p = page();
  let release;
  p.controller.setPreviewSound(
    (_, callback) =>
      new Promise((resolve) => {
        release = async () => resolve(await callback([82, 73, 70, 70]));
      }),
  );
  await p.controller.unlockAudio();
  const abort = new AbortController();
  const pending = p.controller.complete(completion({ turnMode: "off" }), {
    signal: abort.signal,
  });
  abort.abort();
  await release();
  await pending;
  assert.equal(starts(p).length, 0);
  assert.equal(p.shared.claims.size, 0);
  p.controller.dispose();
});

test("storage failure degrades to page deduplication and warns once across both effects", async () => {
  const p = page(undefined, {
    ledger: {
      async claim() {
        throw Error("storage denied");
      },
    },
  });
  await p.controller.unlockAudio();
  await p.controller.complete(completion());
  await p.controller.complete(completion());
  await p.controller.complete(completion({ id: "next" }));
  assert.equal(starts(p).length, 2);
  assert.equal(p.events.notifications.length, 2);
  assert.equal(p.events.warnings.length, 1);
  assert.equal(p.controller.getState().dedupAvailable, false);
  assert.match(p.controller.getState().error, /多个标签页/);
  p.controller.dispose();
});

test("permission is only requested by an explicit action and state subscriptions can detach", async () => {
  const p = page();
  p.state.permission = "default";
  let changes = 0;
  const unsubscribe = p.controller.subscribe(() => changes++);
  await p.controller.complete(completion({ sound: "none" }));
  assert.equal(p.state.permissionRequests, 0);
  assert.equal(await p.controller.requestPermission(), "granted");
  assert.equal(p.state.permissionRequests, 1);
  assert.ok(changes > 0);
  const prior = changes;
  unsubscribe();
  p.controller.setVolume(0.2);
  assert.equal(changes, prior);
  p.controller.dispose();
});

test("safe notification routes encode remote identities and reject cross-origin paths", () => {
  assert.equal(
    notificationNavigationPath("/local/thread?token=secret", "ssh:a&b"),
    "/local/thread?hostId=ssh%3Aa%26b",
  );
  assert.equal(notificationNavigationPath("//evil.test/path", "host"), null);
  assert.equal(
    notificationNavigationPath("https://evil.test/path", "host"),
    null,
  );
  assert.equal(notificationNavigationPath("/\\evil.test/path", "host"), null);
});

test("a hanging storage open times out and closes a late connection", async () => {
  const request = {};
  let closed = 0;
  const ledger = new IndexedDbNotificationLedger({ open: () => request }, 10);
  await assert.rejects(ledger.claim("turn", "audio", 0), /open timed out/);
  request.result = {
    close() {
      closed++;
    },
  };
  request.onsuccess();
  assert.equal(closed, 1);
});

test("a hanging claim aborts its transaction before page-local fallback can run", async () => {
  let aborted = 0;
  let writes = 0;
  const transaction = {
    objectStore() {
      return {
        get() {
          return {};
        },
        add() {
          writes++;
          return {};
        },
      };
    },
    abort() {
      aborted++;
      queueMicrotask(() => transaction.onabort());
    },
  };
  const request = {};
  const factory = {
    open() {
      queueMicrotask(() => {
        request.result = { transaction: () => transaction };
        request.onsuccess();
      });
      return request;
    },
  };
  const ledger = new IndexedDbNotificationLedger(factory, 10);
  await assert.rejects(ledger.claim("turn", "audio", 0), /claim timed out/);
  assert.equal(aborted, 1);
  assert.equal(writes, 0);
});
