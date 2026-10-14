import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { format } from "prettier";

const directory = "scratch/asar/.vite/build/";
const lazy = (initialize) => {
  let initialized = false;
  return () => {
    if (!initialized) {
      initialized = true;
      initialize();
    }
  };
};

/** Use the fixed Desktop's sender, token encoder, size metadata and receiver. */
export async function nativeChunkedRuntime() {
  const [nativeSource, metadata, webview, main] = await Promise.all([
    readFile(`${directory}src-DCNiwad_.js`, "utf8").then((source) =>
      format(source, { parser: "babel" }),
    ),
    readFile(`${directory}application-network-startup-YSC7OAs0.js`, "utf8"),
    readFile("scratch/asar/webview/assets/app-shared-8340f229c2b3.js", "utf8"),
    readFile(`${directory}main-CwxgTOle.js`, "utf8"),
  ]);
  const metadataStart = metadata.indexOf("var Xo=");
  const metadataEnd = metadata.indexOf("var us=", metadataStart);
  assert.ok(metadataStart > 0 && metadataEnd > metadataStart);
  const payloadHelpers = new Function(
    `${metadata.slice(metadataStart, metadataEnd)}; return {w:ts,T:is,C:ls};`,
  )();
  const senderStart = nativeSource.indexOf("var vG = 64,");
  const senderEnd = nativeSource.indexOf("var kG = [", senderStart);
  assert.ok(senderStart > 0 && senderEnd > senderStart);
  const Sender = new Function(
    "o",
    "x",
    "setTimeout",
    "clearTimeout",
    `const le="codex-host-chunked-message-v1"; ${nativeSource.slice(senderStart, senderEnd)}; return DG;`,
  )(
    payloadHelpers,
    { randomUUID },
    (...args) => setTimeout(...args),
    (...args) => clearTimeout(...args),
  );
  const receiverStart = webview.indexOf("function l(");
  const receiverEnd = webview.indexOf("function _(", receiverStart);
  assert.ok(receiverStart > 0 && receiverEnd > receiverStart);
  const Reassembler = new Function(
    "t",
    `${webview.slice(receiverStart, receiverEnd)};g();return m;`,
  )(lazy);
  const wrapperStart = main.indexOf("var Gie = 1e3,");
  const wrapperEnd = main.indexOf("function Jie(", wrapperStart);
  assert.ok(wrapperStart > 0 && wrapperEnd > wrapperStart);
  const wrapper = main
    .slice(wrapperStart, wrapperEnd)
    .replace(/,\s*qie = n\.F\(\[n\.N\(\), n\.D\(\)\.int\(\)\]\);\s*$/, ";");
  return {
    Sender,
    Reassembler,
    createSender(hub, options = {}) {
      // Fail if extraction omitted the production connection patch.
      assert.match(wrapper, /__CODEX_WEB_RENDERERS__\.send/);
      const context = {
        __CODEX_WEB_RENDERERS__: hub,
        i: { Bt: Sender },
        g: { bt: "codex_desktop:message-for-view" },
        f: { i: () => () => ({ warning() {} }) },
      };
      const Wrapper = vm.runInNewContext(`${wrapper}; Kie`, context);
      return new Wrapper(options);
    },
    createFetchBridge(hub, sender, handleVSCodeRequest) {
      const method = (start, end) => {
        const a = main.indexOf(start),
          b = main.indexOf(end, a);
        assert.ok(a > 0 && b > a);
        return main.slice(a, b);
      };
      const methods = [
        method("    getAbortControllerKey(e, t) {", "    async handleRequest("),
        method("    async handleRequest(e, t) {", "    async fetchHttp("),
        method("    cancelRequest(e, t) {", "    async performDesktopFetch("),
        method(
          "    isVsCodeFetchRequest(e) {",
          "    async handleDictationStreamConnectInfoRequest(",
        ),
      ].join("\n");
      assert.match(methods, /__CODEX_WEB_RENDERERS__\.requestKey/);
      const Bridge = vm.runInNewContext(
        `class NativeFetchBridge {abortControllers=new Map; constructor(options,fetchHandler){this.options=options;this.fetchHandler=fetchHandler;} ${methods}};NativeFetchBridge`,
        {
          __CODEX_WEB_RENDERERS__: hub,
          AbortController,
          Error,
          cle: "dictation://test",
          sle: "vscode://codex/",
          r: { In: () => false },
          g: { bt: "codex_desktop:message-for-view" },
          ox: () => "test-error",
        },
      );
      return new Bridge(
        { chunkedMessageSender: sender },
        { handleVSCodeRequest },
      );
    },
  };
}

/** Exercise the Electron shim's actual per-MessagePort sender lifetime. */
export async function appHostEventFactory(hub, parent) {
  const source = await readFile("src/server/electron/index.ts", "utf8");
  const start = source.indexOf("function createIpcMainEvent(");
  const end = source.indexOf("function createIpcMainStub(", start);
  assert.ok(start > 0 && end > start);
  const compiled = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return vm.runInNewContext(
    `let appHostSessionSequence=0;${compiled};createIpcMainEvent`,
    { rendererConnections: hub, getRendererParent: () => parent },
  );
}
