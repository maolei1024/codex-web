import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const primary = await readFile(
  "scratch/asar/webview/assets/app-primary-2a670e99a60c.js",
  "utf8",
);
const initial = await readFile(
  "scratch/asar/webview/assets/app-initial-1ab6fbe93c4f.js",
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
  const state = new Map(),
    scope = {
      value: { kind: "local", placement: "main", clientThreadId: null },
      get: (key) => state.get(key),
      set: (key, value) => state.set(key, value),
      watch: () => () => {},
    };
  const failures = [],
    draft = { text: "keep this draft", images: ["test-image"] };
  let cleared = 0,
    started = 0;
  const expected = Error("[codex-web:transport] Configuration read timed out.");
  const context = {
    ir: () => scope,
    ic: {},
    yE: {},
    ck: () => ({ getText: () => draft.text }),
    WD: () => ({ modelSettings: { isLoading: false } }),
    Ih: () => null,
    q: () => null,
    wm: "account",
    yg: "user",
    yx: {},
    gk: {},
    YT: {},
    AX: {
      use: () => null,
      useRef: (value) => ({ current: value }),
      useEffect() {},
    },
    rp: (fn) => fn,
    TE: "submitting",
    kwe: "accepted",
    sI: {},
    Gv: {},
    bw: () => true,
    Yg: {},
    ur: () => false,
    qR: {},
    yy: {},
    Qut: { default: (fn) => fn },
    YY: () => false,
    qut: () => ({
      isComposerSubmitting: false,
      queueAttachmentSubmit: () => false,
      queueLocalConfigSubmit: () => false,
    }),
    eTe: () => ({
      submit: async () => {
        assert.equal(state.get("submitting"), true);
        throw expected;
      },
    }),
  };
  const hook = vm.runInNewContext(
    `${nativeFunction("Zut", /var Qut[\s,]/)}; Zut`,
    context,
  );
  const { submitComposer } = hook({
    callbacks: {
      clearComposerUi: () => cleared++,
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
  assert.equal(state.get("submitting"), false);
  assert.deepEqual(failures, [expected]);
  assert.equal(cleared, 0);
  assert.equal(started, 0);
  assert.deepEqual(draft, { text: "keep this draft", images: ["test-image"] });
});

test("native deferred submit cancels on config failure and cannot revive when config recovers", async () => {
  let slot = 0,
    pending = false;
  const slots = [],
    memo = cache(31),
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
    useLayoutEffect() {},
    useEffectEvent: (fn) => fn,
    useEffect: (fn) => effects.push(fn),
  };
  const hook = vm.runInNewContext(
    `${nativeFunction("Wut", /var Gut[\s,]/)}; Wut`,
    {
      Gut: { c: () => memo },
      kX: hooks,
      rp: (fn) => fn,
      ic: {},
      Zy: "pending",
      ir: () => ({
        set: (_key, value) => {
          pending = value;
        },
      }),
      q: () => pending,
    },
  );
  let sent = 0,
    fail;
  const loading = new Promise((_resolve, reject) => {
    fail = reject;
  });
  const props = {
    isConfigPending: true,
    configTargetKey: "local/project",
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
  props.isConfigPending = false;
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
    `${nativeFunction("qut", /function Jut\(/)}; qut`,
    {
      Yut: { c: cache },
      J: {},
      sIe: {},
      ll: {},
      ir: () => ({
        get: () => ({ danger: (message) => toasts.push(message) }),
      }),
      q: () => false,
      But() {},
      Jut() {},
      oa: (error) => error.message,
      Rut: async () => {
        throw expected;
      },
      Wut: (options) => {
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
    /T\s*=\s*\(?e\)?\s*=>\s*\{\s*e\.isSnapshot[\s\S]{0,160}?\}/.exec(initial);
  assert.ok(match, "pinned Desktop recovery listener must exist");
  const recovered = [];
  const listener = vm.runInNewContext(
    `(${match[0].replace(/^T\s*=\s*/, "")})`,
    { o: false, S: (host) => recovered.push(host) },
  );
  listener({ hostId: "local", isSnapshot: true });
  assert.deepEqual(recovered, []);
  listener({ hostId: "local", isSnapshot: false });
  listener({ hostId: "remote", isSnapshot: false });
  assert.deepEqual(recovered, ["local", "remote"]);
});
