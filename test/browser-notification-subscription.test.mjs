import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

const initial = await readFile(
  "scratch/asar/webview/assets/app-initial-60d038a052d7.js",
  "utf8",
);
const shared = await readFile(
  "scratch/asar/webview/assets/app-shared-59042e7300f7.js",
  "utf8",
);

function nativeFunction(name, next, source = initial) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${next}(`, start);
  assert.ok(start >= 0 && end > start, `pinned Desktop ${name} must exist`);
  const functionStart =
    source.slice(start - 6, start) === "async " ? start - 6 : start;
  const functionEnd = source.slice(end - 6, end) === "async " ? end - 6 : end;
  return source.slice(functionStart, functionEnd);
}

// Use Desktop's real quiet-completion parser, including padded CDATA envelopes,
// rather than a second implementation of its notification decision rules.
const parseContent = new Function(
  "t",
  `${nativeFunction("qAn", "JAn", shared)}
   ${nativeFunction("sjn", "Wq", shared)}
   Uq(); return sjn;`,
)((fn) => fn);
const isAeon = new Function(
  `${nativeFunction("YY", "XY", shared)}; return YY;`,
)();
const isSubagent = new Function(
  "wz",
  `${nativeFunction("hIr", "gIr", shared)}; return hIr;`,
)((source) => source);
assert.ok(
  /\bJgt\s*=\s*`\/local`/.test(shared),
  "native local navigation prefix",
);
const localPath = new Function(
  "Jgt",
  `${nativeFunction("zht", "Bht", shared)}; return zht;`,
)("/local");
const subscriptionSource = [
  nativeFunction("D6s", "O6s"),
  nativeFunction("T6s", "E6s"),
  nativeFunction("I6s", "L6s"),
  nativeFunction("L6s", "R6s"),
  nativeFunction("R6s", "z6s"),
  nativeFunction("z6s", "B6s"),
].join("\n");

function harness({
  browserHook = true,
  webShim = true,
  focused = false,
  mode = "unfocused",
  sound = "default",
  hostId = "local",
  permission = "default",
  eligible = true,
  remoteTask = false,
  paused = "off",
  conversation: snapshot = {},
  includeTurnNotifications = true,
} = {}) {
  const completions = [],
    nativeShows = [],
    logs = [],
    subscriptions = [];
  const listeners = new Map();
  const values = new Map([
    ["user", "user-a"],
    ["account", "account-a"],
    ["turn-mode", mode],
    ["sound", sound],
  ]);
  const settingReads = [];
  const scope = { get: (key) => values.get(key) };
  const conversation = {
    title: "Session title",
    threadSource: "cli",
    requests: [],
    ...snapshot,
  };
  let permissionRequests = 0;
  const notifications = {
    complete(input, options) {
      completions.push({ input, options });
    },
  };
  const context = {
    window: webShim
      ? { __ELECTRON_SHIM__: browserHook ? { notifications } : {} }
      : {},
    Notification: {
      permission,
      requestPermission() {
        permissionRequests++;
        return Promise.resolve("granted");
      },
    },
    H6s: null,
    V6s: [],
    AbortController,
    URLSearchParams,
    Nu: Object.fromEntries(
      ["info", "debug", "warning", "error"].map((level) => [
        level,
        (...args) => logs.push({ level, args }),
      ]),
    ),
    hne(_scope, actualHost, connect, onEvent) {
      assert.equal(actualHost, hostId);
      return connect(
        {
          rpc: {
            subscribe(options) {
              assert.equal(options.key.hostId, hostId);
              subscriptions.push(options);
              const key = options.event ?? options.methods;
              listeners.set(key, options.listener);
              return () => listeners.delete(key);
            },
          },
        },
        null,
        onEvent,
      );
    },
    E6s: async (_scope, actualHost, id) => {
      assert.equal(actualHost, hostId);
      assert.equal(id, "thread-a");
      return conversation;
    },
    P6s: () => () => {},
    k6s: () => () => {},
    A6s(_scope, actualHost, id, _mode, signal, run) {
      assert.equal(actualHost, hostId);
      assert.equal(id, "thread-a");
      if (eligible && !signal.aborted) run();
    },
    ps: isAeon,
    w5a: () => false,
    KZe: () => paused,
    a$e: isSubagent,
    pp: (value) => value?.title ?? null,
    Hg: localPath,
    eg: (value) => value,
    rIe: parseContent,
    Qbe: { turnMode: "turn-mode", sound: "sound" },
    Pg(get, setting) {
      settingReads.push(setting);
      return get(setting);
    },
    $p: "user",
    dh: "account",
    Ds: "intl",
    Se: {
      notifications: {
        show(input, onOpen) {
          nativeShows.push({ input, onOpen });
        },
        hide() {},
      },
    },
    zi: () => ({
      u(value) {
        return value;
      },
      d() {
        if (this.e) throw this.e;
      },
    }),
  };
  const names = Object.keys(context);
  const subscribe = new Function(
    ...names,
    `${subscriptionSource}; return L6s;`,
  )(...names.map((key) => context[key]));
  const cleanup = subscribe(hostId, {
    scope,
    includeTurnNotifications,
    getIsWindowFocused: () => focused,
    getTurnMode: () => mode,
    getActiveConversationId: () => "thread-a",
    getIsRemoteTask: () => remoteTask,
  });
  const turnListener = listeners.get("turn-completed");
  return {
    completions,
    nativeShows,
    logs,
    values,
    settingReads,
    subscriptions,
    cleanup,
    get permissionRequests() {
      return permissionRequests;
    },
    async emit(event = {}) {
      assert.ok(turnListener, "real turn-completed subscription must exist");
      turnListener({
        conversationId: "thread-a",
        turnId: "turn-a",
        status: "completed",
        lastAgentMessage: "Private assistant response must stay out of alerts",
        ...event,
      });
      await setImmediate();
      const errors = logs.filter((entry) => entry.level === "error");
      assert.deepEqual(
        errors,
        [],
        "native subscription must not swallow errors",
      );
    },
  };
}

test("real completion subscription reaches the independent browser effects in every notification mode and focus state", async (t) => {
  for (const focused of [true, false]) {
    for (const mode of ["off", "unfocused", "always"]) {
      await t.test(`${mode}, focused=${focused}`, async () => {
        const instance = harness({ focused, mode });
        await instance.emit();
        assert.equal(instance.completions.length, 1);
        const { input } = instance.completions[0];
        assert.equal(input.turnMode, mode);
        assert.equal(input.sound, "default");
        assert.equal(instance.nativeShows.length, 0);
        instance.cleanup();
      });
    }
  }
});

test("browser completion payload preserves identity and native navigation without sending response content", async () => {
  const instance = harness({ hostId: "ssh:remote host" });
  await instance.emit();
  const { input, options } = instance.completions[0];
  assert.equal(
    input.id,
    'turn-["user-a","account-a","ssh:remote host","thread-a","turn-a"]',
  );
  assert.equal(input.title, "Session title");
  assert.equal(input.hostId, "ssh:remote host");
  assert.equal(input.conversationId, "thread-a");
  assert.equal(input.turnId, "turn-a");
  assert.equal(input.status, "completed");
  assert.equal(
    input.navigationPath,
    "/local/thread-a?hostId=ssh%3Aremote+host",
  );
  assert.equal(input.navigationState, undefined);
  assert.equal("body" in input, false);
  assert.equal("lastAgentMessage" in input, false);
  assert.equal(
    JSON.stringify(input).includes("Private assistant response"),
    false,
  );
  assert.deepEqual(options.onOpen(), {
    path: "/local/thread-a?hostId=ssh%3Aremote+host",
    state: undefined,
  });
  assert.equal(options.signal.aborted, false);
  instance.cleanup();
  assert.equal(options.signal.aborted, true);
});

test("notification clicks retain native side conversation navigation state and remote fallback", async () => {
  const instance = harness({
    hostId: "ssh:remote",
    conversation: {
      sideConversationParentNavigationPath: "/local/parent-thread",
    },
  });
  await instance.emit();
  const { input, options } = instance.completions[0];
  assert.equal(input.navigationPath, "/local/parent-thread");
  assert.deepEqual(input.navigationState, {
    activateTabId: "sidechat:thread-a",
  });
  assert.equal("activateTabFallbackPath" in input.navigationState, false);
  assert.deepEqual(options.onOpen(), {
    path: "/local/parent-thread",
    state: {
      activateTabId: "sidechat:thread-a",
      activateTabFallbackPath: "/local/thread-a?hostId=ssh%3Aremote",
    },
  });
  instance.cleanup();
});

test("completion reads current sound and popup settings rather than subscription-time values", async () => {
  const instance = harness({
    focused: true,
    mode: "unfocused",
    sound: "default",
  });
  instance.values.set("turn-mode", "off");
  instance.values.set("sound", "none");
  await instance.emit();
  assert.equal(instance.completions.length, 1);
  assert.equal(instance.completions[0].input.turnMode, "off");
  assert.equal(instance.completions[0].input.sound, "none");
  assert.deepEqual(instance.settingReads, ["turn-mode", "sound"]);
  assert.equal(instance.nativeShows.length, 0);
  instance.cleanup();
});

test("failed, interrupted and unfinished turns never invoke successful completion effects", async (t) => {
  for (const status of ["failed", "interrupted", "inProgress"]) {
    await t.test(status, async () => {
      const instance = harness();
      await instance.emit({ status });
      assert.equal(instance.completions.length, 0);
      assert.equal(instance.nativeShows.length, 0);
      instance.cleanup();
    });
  }
});

test("original silent-task, source, heartbeat and continuation decisions still suppress browser effects", async (t) => {
  const cases = [
    {
      label: "automation DONT_NOTIFY",
      event: { automationNotificationDecision: "DONT_NOTIFY" },
    },
    {
      label: "heartbeat DONT_NOTIFY",
      event: { heartbeatAssistantMessage: { decision: "DONT_NOTIFY" } },
    },
    {
      label: "skipped completion",
      event: { lastAgentMessage: ":: SKIP_COMPLETION ::" },
    },
    {
      label: "padded CDATA skipped completion",
      event: { lastAgentMessage: "<![CDATA[ :: SKIP_COMPLETION :: ]]>" },
    },
    { label: "pending continuation", event: { hasPendingContinuation: true } },
    {
      label: "hidden source",
      options: { conversation: { threadSource: "chatgpt_hidden" } },
    },
    {
      label: "dreaming source",
      options: { conversation: { threadSource: "dreaming" } },
    },
    {
      label: "Aeon start kind",
      options: { conversation: { threadStartKind: "aeon" } },
    },
    {
      label: "Aeon source",
      options: { conversation: { threadSource: "aeon" } },
    },
    {
      label: "subagent parent thread",
      options: { conversation: { parentThreadId: "parent" } },
    },
    {
      label: "subagent source parent",
      options: { conversation: { source: { parentThreadId: "parent" } } },
    },
    { label: "paused durable task", options: { paused: "sleeping" } },
    { label: "remote ChatGPT Work task", options: { remoteTask: true } },
    { label: "native task eligibility denied", options: { eligible: false } },
  ];
  for (const { label, options, event } of cases) {
    await t.test(label, async () => {
      const instance = harness(options);
      await instance.emit(event);
      assert.equal(instance.completions.length, 0);
      assert.equal(instance.nativeShows.length, 0);
      instance.cleanup();
    });
  }
});

test("tool-only successful turns with no assistant body still reach the completion hook", async () => {
  const instance = harness({ focused: true, mode: "off" });
  await instance.emit({ lastAgentMessage: null });
  assert.equal(instance.completions.length, 1);
  assert.equal(instance.completions[0].input.status, "completed");
  assert.equal("body" in instance.completions[0].input, false);
  assert.equal(instance.nativeShows.length, 0);
  instance.cleanup();
});

test("explicit automation NOTIFY takes precedence over heartbeat DONT_NOTIFY", async () => {
  const instance = harness();
  await instance.emit({
    automationNotificationDecision: "NOTIFY",
    heartbeatAssistantMessage: {
      decision: "DONT_NOTIFY",
      notificationMessage: "Heartbeat complete",
    },
  });
  assert.equal(instance.completions.length, 1);
  instance.cleanup();
});

test("browser startup leaves permission requests to an explicit settings click", async () => {
  const instance = harness({ permission: "default" });
  await setImmediate();
  assert.equal(instance.permissionRequests, 0);
  instance.cleanup();
});

test("without a browser completion hook the original native notification path is retained", async (t) => {
  for (const { mode, focused, expected } of [
    { mode: "unfocused", focused: false, expected: 1 },
    { mode: "unfocused", focused: true, expected: 0 },
    { mode: "off", focused: false, expected: 0 },
    { mode: "always", focused: true, expected: 1 },
  ]) {
    await t.test(`${mode}, focused=${focused}`, async () => {
      const instance = harness({ browserHook: false, focused, mode });
      await instance.emit();
      assert.equal(instance.completions.length, 0);
      assert.equal(instance.nativeShows.length, expected);
      if (expected) {
        assert.equal(
          instance.nativeShows[0].input.body,
          "Private assistant response must stay out of alerts",
        );
        assert.deepEqual(instance.nativeShows[0].onOpen({ type: "open" }), {
          path: "/local/thread-a",
          state: undefined,
        });
      }
      instance.cleanup();
    });
  }
  await t.test("Desktop without the Web shim", async () => {
    const instance = harness({
      browserHook: false,
      webShim: false,
      mode: "always",
      permission: "default",
    });
    await instance.emit();
    assert.equal(instance.completions.length, 0);
    assert.equal(instance.nativeShows.length, 1);
    assert.equal(instance.permissionRequests, 1);
    instance.cleanup();
  });
});

test("disabled or disposed subscriptions cannot issue completion effects", async () => {
  const disabled = harness({ includeTurnNotifications: false });
  assert.equal(
    disabled.subscriptions.some((entry) => entry.event === "turn-completed"),
    false,
  );
  disabled.cleanup();
  const disposed = harness();
  disposed.cleanup();
  await disposed.emit();
  assert.equal(disposed.completions.length, 0);
  assert.equal(disposed.nativeShows.length, 0);
});
