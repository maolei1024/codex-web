import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { importTypescriptModule } from "./import-typescript-module.mjs";
const { AppHostRecovery } = await importTypescriptModule(
  "src/browser/app-host-recovery.ts",
);
const { DiagnosticJournal } = await importTypescriptModule(
  "src/browser/diagnostic-journal.ts",
);
const { DiagnosticRuntime, diagnosticObserver } = await importTypescriptModule(
  "src/browser/diagnostic-runtime.ts",
);
const source = await readFile(
  "scratch/asar/webview/assets/app-shared-8340f229c2b3.js",
  "utf8",
);
function nativeFunction(name, next) {
  const start = source.indexOf(`function ${name}(`),
    end = source.indexOf(next, start);
  assert.ok(start > 0 && end > start, `pinned native ${name}`);
  return source.slice(start, end);
}
const start = /cfn\s*=\s*(class)/.exec(source);
assert.ok(start, "pinned native queued-message coordinator");
const rest = source.slice(
  start.index + start[0].indexOf("class"),
  source.indexOf("function ufn(", start.index),
);
const ast = ts.createSourceFile(
  "fixture.js",
  `const Queue = ${rest}`,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const queueClass =
  ast.statements[0].declarationList.declarations[0].initializer.getText(ast);
const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

async function setup(t, { hideAt, mode = "ordinary", failAt, blockAt } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const journal = new DiagnosticJournal({ now: Date.now, mono: Date.now });
  const runtime = diagnosticObserver(new DiagnosticRuntime(journal));
  const app = new AppHostRecovery();
  app.diagnosticObserver = runtime.appHost;
  app.configure(() => ({
    services: Promise.resolve({
      settings: { readAll: async () => ({}) },
      startup: { whenReady: async () => {} },
    }),
    close() {},
  }));
  const services = await app.start();
  await services.settings.readAll();
  await services.startup.whenReady();
  for (const method of ["config/read", "configRequirements/read", "model/list"])
    app.observeNative({ method, type: "completed" });
  assert.equal(app.diagnostics().cycle, null);
  let hidden = false,
    state = {},
    lock = false,
    starts = 0,
    releases = 0,
    seq = 0;
  const writes = [],
    requests = [];
  const phase = (name) => {
    if (name === hideAt && !hidden) {
      hidden = true;
      app.suspend("hidden");
      journal.lifecycle("visibility", { hidden: true });
      t.mock.timers.tick(11 * 60_000);
    }
    if (name === failAt) throw Error("synthetic preparation failure");
  };
  const fetch = async (method, options = {}) => {
    phase(method);
    if (method === blockAt) app.suspend("offline");
    const op = runtime.id(options);
    return app.fetchRequest(
      `vscode://codex/${method}`,
      options.signal,
      async (_signal, parentId) => {
        const id = `wire-${++seq}`;
        runtime.fetchStart(
          id,
          `vscode://codex/${method}`,
          runtime.tag(
            {
              ...options,
              [Symbol.for("codex-web.diagnostic.request")]: parentId,
            },
            op,
          ),
        );
        requests.push({ method, operationId: op });
        await Promise.resolve();
        let value;
        if (method === "get-global-state") value = { value: state };
        else if (method === "set-global-state") {
          state = options.params.value;
          value = { success: true };
        } else if (method === "queued-follow-up-send-lock-acquire") {
          assert.equal(lock, false);
          lock = true;
          value = { acquired: true };
        } else if (method === "queued-follow-up-send-lock-release") {
          assert.equal(lock, true);
          lock = false;
          releases++;
          value = {};
        } else value = {};
        runtime.fetchEnd(id);
        return value;
      },
      options.params,
      { operationId: op },
    );
  };
  const context = vm.createContext({
    window: { __ELECTRON_SHIM__: { diagnosticRuntime: runtime } },
    vF: class {},
    TH: { default: isDeepStrictEqual },
    ofn: { default: (x) => x },
    wH: class extends Error {},
    DB: class extends Error {},
    cz: class extends Error {},
    lz: class extends Error {},
    EH: [],
    sfn: "submission-outcome-unknown",
    Cle: () => false,
    Y: (x) => x,
    dz: class {
      constructor(fn) {
        this[Symbol.dispose] = fn;
      }
    },
    GI: () => {
      const values = [];
      return {
        u(v) {
          values.push(v);
        },
        e: undefined,
        d() {
          for (const v of values.reverse()) v[Symbol.dispose]?.();
          if (this.e) throw this.e;
        },
      };
    },
    pN: () => {
      let resolve, reject;
      const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
      });
      return { promise, resolve, reject };
    },
    YH: () => "local",
    gNt: 1000,
    Lvn: () => null,
    e6: {},
    ubn: () => false,
    lW: () => false,
    JT: () => `id-${++seq}`,
    mzn: () => true,
    hzn() {},
    _I() {},
    yI() {},
    nK: () => ({ isLoading: false, data: state }),
    Nj: { QUEUED_FOLLOW_UPS: "queue" },
    ODn: (_key, x) => x,
    rK: {},
    jDn: {},
    GG() {},
    U: () => ({ parse: (x) => x }),
    console,
  });
  vm.runInContext(nativeFunction("ifn", "var wH"), context);
  // Bundled assets may be minified, so use TypeScript to select the exact function.
  function evaluateFunction(name) {
    const from = source.indexOf(`function ${name}(`);
    const parsed = ts.createSourceFile(
      "native.js",
      source.slice(from, from + 30000),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    return vm.runInContext(
      `(${parsed.statements[0].getText(parsed)})`,
      context,
    );
  }
  context.TDn = evaluateFunction("TDn");
  context.wDn = evaluateFunction("wDn");
  const scopeQueue = {},
    scope = {
      get: () => scopeQueue,
      query: {
        snapshot: () => ({
          setData() {},
          invalidate: async () => {},
          queryKey: "queue",
        }),
      },
    };
  const storage = evaluateFunction("XUn")(scope, fetch);
  const execution = evaluateFunction("QUn")(
    null,
    fetch,
    () => true,
  ).queuedMessages;
  Object.assign(execution, {
    isClientReady: () => true,
    errorReason: () => "synthetic",
    prepare: async () => {
      throw Error("unexpected replay preparation");
    },
  });
  const options = {},
    operationId = runtime.start(options, mode),
    message = {
      id: "message-fixture",
      context: {},
      submissionOptions: options,
    };
  runtime.bindMessage(message.id, operationId);
  const submissionHost = {
    needsResume: () => mode === "new",
    resume: async () => {
      phase("session");
      await fetch("get-global-state", runtime.tag({}, operationId));
      return { status: "ready" };
    },
    hasPendingTurnStart: () => mode === "follow-up",
    getActiveTurnId: () => (mode === "steer" ? "active-turn" : null),
    hasFinalAnswer: () => false,
    start: async () => send("turn/start"),
    steer: async () => send("turn/steer"),
  };
  async function send(method) {
    phase("write");
    starts++;
    writes.push(method);
    const id = `rpc-${++seq}`;
    runtime.registerNative(
      "local",
      id,
      method,
      { clientUserMessageId: message.id },
      runtime.tag({}, operationId),
    );
    runtime.delivered("local", id, "dispatched");
    runtime.delivered("local", id, "acknowledged");
    assert.equal(journal.snapshot().operations[0].outcome, "outcome-unknown");
    await Promise.resolve();
    runtime.nativeEvent({
      hostId: "local",
      id,
      method,
      type: "completed",
      result: { turn: { id: "turn-fixture" } },
    });
    return "turn-fixture";
  }
  const Queue = vm.runInContext(`(${queueClass})`, context);
  const queue = new Queue({
    hostId: "local",
    submissionHost,
    isDurableThread: () => false,
    getMessageQueueMode: async () =>
      mode === "follow-up" ? "queue" : "send-only",
    createMessageThreadId: () => "fixture",
    getStreamRole: () => ({ role: "owner" }),
    canSend: () => true,
    wasMessageAccepted: () => false,
    logger: { warning() {}, error() {} },
    storage: {
      read: () => ({ isLoading: false, value: state }),
      load: () => storage.loadQueuedFollowUps(),
      update: (fn, id) => storage.updateQueuedFollowUps(fn, id),
    },
  });
  await queue.executionReady;
  if (mode !== "follow-up") queue.execution = execution;
  t.after(() => {
    queue.dispose();
    app.expireRecovery();
    journal.dispose();
  });
  async function prepare() {
    phase("attachments");
    await fetch("read-file-metadata", runtime.tag({}, operationId));
    phase("configuration");
    await fetch("get-global-state", runtime.tag({}, operationId));
    await services.settings.readAll();
    return {
      conversationId: "thread",
      resume: { conversationId: "thread" },
      start: {},
      steer: {},
      allowStartAfterNoActiveTurn: false,
    };
  }
  const sending = queue.sendMessage(
    {
      conversationId: "thread",
      message,
      options,
      acceptLocally: mode !== "follow-up",
    },
    prepare,
    () => runtime.step(operationId, "unlocked", { locked: false }),
  );
  // Observe rejection immediately, even for a failed asynchronous local enqueue.
  sending.catch(() => {});
  return {
    app,
    journal,
    runtime,
    sending,
    operationId,
    requests,
    writes,
    phase,
    get starts() {
      return starts;
    },
    get hidden() {
      return hidden;
    },
    get releases() {
      return releases;
    },
    get locked() {
      return lock;
    },
  };
}

for (const [mode, hideAt] of [
  ["ordinary", "set-global-state"],
  ["ordinary", "queued-follow-up-send-lock-acquire"],
  ["new", "session"],
  ["ordinary", "attachments"],
  ["ordinary", "configuration"],
  ["steer", "write"],
]) {
  test(`native ${mode} submit hidden during ${hideAt} reaches acceptance without foreground`, async (t) => {
    const f = await setup(t, { mode, hideAt });
    await flush();
    const result = await f.sending;
    assert.equal(result.status, "sent");
    assert.equal(f.hidden, true);
    assert.equal(f.starts, 1);
    assert.equal(f.locked, false);
    assert.equal(f.releases, 1);
    const report = f.journal.snapshot(),
      operation = report.operations.find((x) => x.id === f.operationId);
    assert.equal(operation.outcome, "accepted");
    assert.equal(operation.preparationActive, false);
    assert.ok(
      f.requests.some(
        (x) =>
          x.method === "set-global-state" && x.operationId === f.operationId,
      ),
    );
    assert.ok(
      f.requests.some(
        (x) =>
          x.method === "queued-follow-up-send-lock-acquire" &&
          x.operationId === f.operationId,
      ),
    );
    assert.equal(f.app.suspended, true);
  });
}

test("native attachment preparation failure releases the send lock and does not dispatch", async (t) => {
  const f = await setup(t, {
    hideAt: "queued-follow-up-send-lock-acquire",
    failAt: "attachments",
  });
  await assert.rejects(f.sending, /synthetic preparation failure/);
  await flush();
  assert.equal(f.starts, 0);
  assert.equal(f.locked, false);
  assert.equal(f.releases, 1);
  assert.equal(f.journal.snapshot().operations[0].outcome, "not-sent");
});

test("native queued follow-up preserves local queue semantics without claiming backend acceptance", async (t) => {
  const f = await setup(t, { mode: "follow-up", hideAt: "set-global-state" });
  assert.equal((await f.sending).status, "queued");
  await flush();
  assert.equal(f.starts, 0);
  assert.equal(f.locked, false);
  const op = f.journal.snapshot().operations[0];
  assert.equal(op.mode, "follow-up");
  assert.equal(op.outcome, "outcome-unknown");
  assert.equal(op.preparationActive, false);
});

test("retiring a hidden blocked native submit cannot send after recovery", async (t) => {
  const f = await setup(t, {
    hideAt: "get-global-state",
    blockAt: "get-global-state",
  });
  await flush();
  assert.ok(f.journal.pendingDetails().some((r) => r.state === "waiting"));
  f.app.resetRecovery(true);
  await assert.rejects(f.sending);
  f.app.resume();
  await flush();
  assert.equal(f.starts, 0);
  assert.equal(f.locked, false);
});

test("native fetch facade propagates operation context through POST without adding it to the payload", async (t) => {
  const journal = new DiagnosticJournal();
  t.after(() => journal.dispose());
  const runtime = diagnosticObserver(new DiagnosticRuntime(journal)),
    id = runtime.start({}),
    calls = [];
  const context = vm.createContext({
    window: { __ELECTRON_SHIM__: { diagnosticRuntime: runtime } },
    xDn: () => undefined,
  });
  const begin = source.indexOf("async post("),
    end = source.indexOf("async put(", begin);
  assert.ok(begin > 0 && end > begin);
  const http = vm.runInContext(`({${source.slice(begin, end)}})`, context);
  http.sendRequest = async (method, url, options) => {
    calls.push({ method, url, options });
    return { body: { value: true } };
  };
  context.AW = { getInstance: () => http };
  for (const name of ["yDn", "$G"]) {
    const from = source.indexOf(`function ${name}(`);
    const parsed = ts.createSourceFile(
      "fetch.js",
      source.slice(from - 6, from + 5000),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    context[name] = vm.runInContext(
      `(${parsed.statements[0].getText(parsed)})`,
      context,
    );
  }
  await context.$G(
    "get-global-state",
    runtime.tag({ params: { key: "synthetic-key" } }, id),
  );
  assert.equal(calls.length, 1);
  assert.equal(runtime.id(calls[0].options), id);
  assert.equal(calls[0].options.body, JSON.stringify({ key: "synthetic-key" }));
  assert.ok(!JSON.stringify(calls[0]).includes(id));
});
