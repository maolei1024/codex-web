import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const primary = await readFile(
  "scratch/asar/webview/assets/app-primary-6b28e06666ff.js",
  "utf8",
);
const initial = await readFile(
  "scratch/asar/webview/assets/app-initial-236e1501144c.js",
  "utf8",
);
const sentinel = Symbol.for("react.memo_cache_sentinel");
const cache = (size) => Array(size).fill(sentinel);
function nativeFunction(name, end, source = primary) {
  const start = source.indexOf(`function ${name}(`);
  const match = end.exec(source.slice(start));
  assert.ok(start >= 0 && match, `pinned Desktop ${name} must exist`);
  const prefix = source.slice(start - 6, start) === "async " ? "async " : "";
  return prefix + source.slice(start, start + match.index);
}

test("native early submit failure reports the error and releases its real submission lock", async () => {
  const PD = {},
    Vx = {},
    FE = {},
    jl = {};
  const state = new Map([
    [PD, false],
    [Vx, null],
    [FE, "local"],
    [jl, []],
  ]);
  const scope = {
    value: { kind: "local", clientThreadId: null },
    get: (key) => state.get(key),
    set: (key, value) => state.set(key, value),
  };
  const failures = [];
  const draft = { text: "keep this draft", images: ["test-image"] };
  let cleared = 0,
    started = 0;
  const expected = Error("[codex-web:transport] Configuration read timed out.");
  const context = {
    PD,
    Vx,
    FE,
    jl,
    US: {},
    MT: () => scope,
    lv: () => null,
    gn: () => ({ modelSettings: { isLoading: false } }),
    pH: () => ({
      getText: () => draft.text,
      getPersistedText: () => draft.text,
      getMentionedBrowserFamilies: () => [],
    }),
    uD: (fn) => fn,
    OXr: () => ({
      queueAttachmentSubmit: () => false,
      queueLocalConfigSubmit: () => false,
    }),
    rYr: () => false,
    Nqr: () => [],
    Fqr: () => false,
    performance: { timeOrigin: 0, now: () => 1 },
    K1t: () => false,
  };
  const submitHook = vm.runInNewContext(
    `${nativeFunction("mXr", /function hXr\(/)}; ${nativeFunction("MXr", /var NXr\s*=/)}; MXr`,
    context,
  );
  const { submitComposer } = submitHook({
    callbacks: {
      clearStopTurnConfirmation() {},
      clearComposerUi: () => cleared++,
      getDefaultFollowUpSubmitAction: () => "steer",
      prepareThreadGoalSubmit: async () => {
        assert.equal(state.get(PD), true);
        throw expected;
      },
      handleSubmitError: (error) => failures.push(error),
    },
    submissionState: {
      submitDisabled: false,
      submitBlockContext: { composerMode: "local" },
      localConfigTarget: {},
    },
    submitTarget: { type: "local", submit: () => started++ },
  });
  await submitComposer();
  assert.equal(state.get(PD), false);
  assert.deepEqual(failures, [expected]);
  assert.equal(cleared, 0);
  assert.equal(started, 0);
  assert.deepEqual(draft, { text: "keep this draft", images: ["test-image"] });
});

test("native deferred submit cancels on config failure and cannot revive when config recovers", async () => {
  let slot = 0;
  const slots = [],
    memo = cache(26),
    effects = [];
  const hooks = {
    useRef(value) {
      const i = slot++;
      return (slots[i] ??= { current: value });
    },
    useState(value) {
      const i = slot++;
      if (!(i in slots)) slots[i] = value;
      return [
        slots[i],
        (value) => {
          slots[i] = value;
        },
      ];
    },
    useEffectEvent: (fn) => fn,
    useEffect: (fn) => effects.push(fn),
  };
  const hook = vm.runInNewContext(
    `${nativeFunction("TXr", /var EXr[\s,]/)}; TXr`,
    { EXr: { c: () => memo }, A9: hooks, uD: (fn) => fn },
  );
  let sent = 0,
    fail;
  const loading = new Promise((_resolve, reject) => {
    fail = reject;
  });
  const props = {
    isLocalConfigPending: true,
    localConfigTargetKey: "local/project",
    submitTargetKey: "thread",
    onSubmitQueued: () => loading,
    submitComposer: () => sent++,
    submitDirectComment: () => sent++,
  };
  const render = () => {
    slot = 0;
    const result = hook(props);
    effects.splice(0).forEach((effect) => effect());
    return result;
  };
  assert.equal(render().queueSubmit({ type: "composer", options: {} }), true);
  assert.equal(render().hasPendingSubmit, true);
  fail(Error("config unavailable"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(render().hasPendingSubmit, false);
  props.isLocalConfigPending = false;
  render();
  render();
  assert.equal(
    sent,
    0,
    "a later successful config refresh must not send the canceled draft",
  );
});

test("native queued configuration errors remain rejected after displaying a toast", async () => {
  const expected = Error("config unavailable"),
    toasts = [];
  let queued;
  const hook = vm.runInNewContext(
    `${nativeFunction("OXr", /function kXr\(/)}; OXr`,
    {
      AXr: { c: cache },
      Em: {},
      eye: {},
      Ex: {},
      MT: () => ({
        get: () => ({ danger: (message) => toasts.push(message) }),
      }),
      kx: () => false,
      xXr() {},
      kXr() {},
      $f: (error) => error.message,
      yXr: async () => {
        throw expected;
      },
      TXr: (options) => {
        queued = options.onSubmitQueued;
        return {};
      },
    },
  );
  hook({});
  await assert.rejects(queued(), (error) => error === expected);
  assert.deepEqual(toasts, [expected.message]);
});

test("the native recovery listener ignores snapshots but accepts bridge recovery events", () => {
  const match =
    /D\s*=\s*\(?e\)?\s*=>\s*\{\s*e\.isSnapshot[\s\S]{0,160}?\}/.exec(initial);
  assert.ok(match, "pinned Desktop recovery listener must exist");
  const recovered = [];
  const listener = vm.runInNewContext(
    `(${match[0].replace(/^D\s*=\s*/, "")})`,
    { o: false, C: (host) => recovered.push(host) },
  );
  listener({ hostId: "local", isSnapshot: true });
  assert.deepEqual(recovered, []);
  listener({ hostId: "local", isSnapshot: false });
  listener({ hostId: "remote", isSnapshot: false });
  assert.deepEqual(recovered, ["local", "remote"]);
});
