import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export async function cacheModules() {
  const dir = await mkdtemp(`${tmpdir()}/codex-thread-cache-modules-`);
  try {
    for (const name of [
      "thread-cache-store",
      "thread-cache-codec",
      "thread-cache",
    ]) {
      const source = await readFile(`src/browser/${name}.ts`, "utf8");
      const js = ts
        .transpileModule(source, {
          compilerOptions: {
            module: ts.ModuleKind.ES2022,
            target: ts.ScriptTarget.ES2022,
          },
        })
        .outputText.replaceAll(
          '"./thread-cache-store"',
          '"./thread-cache-store.mjs"',
        )
        .replaceAll('"./thread-cache-codec"', '"./thread-cache-codec.mjs"');
      await writeFile(`${dir}/${name}.mjs`, js);
    }
    return {
      ...(await import(pathToFileURL(`${dir}/thread-cache.mjs`))),
      ...(await import(pathToFileURL(`${dir}/thread-cache-codec.mjs`))),
      ...(await import(pathToFileURL(`${dir}/thread-cache-store.mjs`))),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Extract the pinned native subscription selectors and transcript construction. */
export async function desktopThreadRuntime() {
  const source = await readFile(
    "scratch/asar/webview/assets/app-shared-8340f229c2b3.js",
    "utf8",
  );
  const classSource = (name, end) => {
    const start = new RegExp(`${name}\\s*=\\s*class`).exec(source);
    assert.ok(start, `${name} must exist in the pinned Desktop`);
    const code = source.slice(
      start.index,
      source.indexOf(`function ${end}(`, start.index),
    );
    const file = ts.createSourceFile(
      "native.js",
      `const Value = ${code.slice(code.indexOf("class"))}`,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.JS,
    );
    return file.statements[0].declarationList.declarations[0].initializer.getText(
      file,
    );
  };
  const functions = (start, end) => {
    const a = source.indexOf(`function ${start}(`),
      b = source.indexOf(`function ${end}(`, a);
    assert.ok(a >= 0 && b > a);
    return source.slice(a, b);
  };
  const helpers =
    functions("G6t", "wB") +
    functions("Y0t", "mz") +
    functions("bz", "e2t") +
    functions("AB", "r8t") +
    functions("i8t", "o8t").replace(/var a8t;?\s*$/, "");
  return new Function(
    "Z6t",
    `${helpers};return {Subscriptions:${classSource("U6t", "G6t")},Readers:${classSource("c8t", "MB")},transcript:n8t,placeholder:G6t,complete:bz};`,
  )(() => null);
}

export function makeManager(runtime, identity = "account-one", host = "local") {
  const states = new Map(),
    events = new Map();
  const on = (type, fn) => {
    const set = events.get(type) ?? new Set();
    set.add(fn);
    events.set(type, set);
    return () => set.delete(fn);
  };
  const emit = (type, ...args) => {
    for (const fn of events.get(type) ?? []) fn(...args);
  };
  const reader = new runtime.Readers({
    getHostId: () => host,
    getConversation: (id) => states.get(id),
    readItemActivity: () => null,
  });
  const owner = {
    getConversation: (id) => states.get(id) ?? null,
    getTranscript: (id) => reader.getTranscript(id),
    getTurn: (c, key) => reader.getSubscribedTurn(c, key),
    threadFieldReaders: reader.threadFieldReaders,
    turnFieldReaders: reader.turnFieldReaders,
  };
  const subscriptions = new runtime.Subscriptions(owner);
  const manager = {
    threadStore: { subscriptions, stateReaders: reader },
    readState: {
      historyCacheIdentity: () => identity,
      identityKey: () => "native-ephemeral-epoch",
      isReady: () => !!identity,
      executionHostKey: () => `execution-${host}`,
      subscribeStatus: (fn) => on("identity", fn),
    },
    getHostId: () => host,
    getConversation: (id) => states.get(id),
    addConversationStateCallback: (fn) => on("state", fn),
    addTurnCompletedListener: (fn) => on("complete", fn),
    addThreadDeletedListener: (fn) => on("delete", fn),
    addNotificationCallback: (method, fn) => on(method, fn),
    addAuthStatusCallback: (fn) => {
      on("auth", fn);
    },
    removeAuthStatusCallback: (fn) => events.get("auth")?.delete(fn),
    applyRollbackResponseToConversation: ({ conversationId, state }) =>
      set(conversationId, state),
    applyRevertResponseToConversation: ({ conversationId, state }) =>
      set(conversationId, state),
  };
  function set(id, state) {
    states.set(id, state);
    subscriptions.notifyTranscript(id, reader.getTranscript(id));
    emit("state", id, state);
  }
  return {
    manager,
    states,
    reader,
    subscriptions,
    set,
    emit,
    identity: (value) => {
      identity = value;
      emit("identity");
    },
    native: {
      readState: manager.readState,
      complete: runtime.complete,
      placeholder: (id, metadata) =>
        runtime.placeholder({ ...metadata, conversationId: id, hostId: host }),
      turns: (c) => c.turns,
      transcript: (c) => ({
        type: "reset",
        value: runtime.transcript(c, reader.transcriptAccess),
      }),
    },
  };
}
