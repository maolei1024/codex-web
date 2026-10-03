import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

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
  const [bootstrap, metadata, webview, main] = await Promise.all([
    readFile(`${directory}bootstrap-yYZ8rgHq.js`, "utf8"),
    readFile(`${directory}application-network-startup-DN7Ktmlk.js`, "utf8"),
    readFile("scratch/asar/webview/assets/app-shared-59042e7300f7.js", "utf8"),
    readFile(`${directory}main-C3nRcJ3D.js`, "utf8"),
  ]);
  const metadataStart = metadata.indexOf("var Yo=");
  const metadataEnd = metadata.indexOf("var ls=", metadataStart);
  assert.ok(metadataStart > 0 && metadataEnd > metadataStart);
  const payloadHelpers = new Function(
    `${metadata.slice(metadataStart, metadataEnd)}; return {S:es,x:cs,C:rs};`,
  )();
  const senderStart = bootstrap.indexOf("var MR = 64,");
  const senderEnd = bootstrap.indexOf("var UR = [", senderStart);
  assert.ok(senderStart > 0 && senderEnd > senderStart);
  const Sender = new Function(
    "o",
    "D",
    "setTimeout",
    "clearTimeout",
    `const Be="codex-host-chunked-message-v1"; ${bootstrap.slice(senderStart, senderEnd)}; return VR;`,
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
  const wrapperStart = main.indexOf("var Nie = 1e3,");
  const wrapperEnd = main.indexOf("function Iie(", wrapperStart);
  assert.ok(wrapperStart > 0 && wrapperEnd > wrapperStart);
  const wrapper = main
    .slice(wrapperStart, wrapperEnd)
    .replace(/,\s*Fie = n\.F\(\[n\.N\(\), n\.D\(\)\.int\(\)\]\);\s*$/, ";");
  return {
    Sender,
    Reassembler,
    createSender(hub, options = {}) {
      // Fail if extraction omitted the production connection patch.
      assert.match(wrapper, /__CODEX_WEB_RENDERERS__\.send/);
      const context = {
        __CODEX_WEB_RENDERERS__: hub,
        m: { sr: Sender, Q: "codex_desktop:message-for-view" },
        u: { i: () => () => ({ warning() {} }) },
      };
      const Wrapper = vm.runInNewContext(`${wrapper}; Pie`, context);
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
          Hb: "dictation://test",
          Vb: "vscode://codex/",
          r: { Xn: () => false },
          m: { Q: "codex_desktop:message-for-view" },
          Jb: () => "test-error",
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
