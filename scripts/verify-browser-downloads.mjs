#!/usr/bin/env node
/** Isolated real-browser download checks. Never activate/restart production or send a task. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  chmod,
  unlink,
  open,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = path.resolve(
  process.argv[2] ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const baselineUIOnly = process.argv.includes("--baseline-ui-only");
if (!baselineUIOnly && await realpath(root) === await realpath("/srv/docker-data/codex-web/runtime")) {
  throw new Error("Refusing to use the active release as a writable shadow fixture");
}
const build = JSON.parse(
  await readFile(path.join(root, "local-build.json"), "utf8"),
).id;
const runtime = await mkdtemp(
  "/tmp/codex-web-download-browser-",
);
await chmod(runtime, 0o700);
const codexTestHome = path.join(runtime, "codex-home");
await mkdir(codexTestHome, { mode: 0o700 });
const configFiles = ["auth.json", "config.toml"];
const hash = (data) => createHash("sha256").update(data).digest("hex");
const configHashes = await Promise.all(
  configFiles.map(async (name) => {
    const file = path.join("/home/ml/.codex", name);
    await copyFile(file, path.join(codexTestHome, name));
    await chmod(path.join(codexTestHome, name), 0o600);
    return hash(await readFile(file));
  }),
);
// Exercise the already-onboarded upgrade case without copying any task state,
// queued follow-ups, drafts, permissions or production workspace assignments.
const existingState = JSON.parse(await readFile("/home/ml/.codex/.codex-global-state.json", "utf8"));
const onboarding = Object.fromEntries(Object.entries(existingState["electron-persisted-atom-state"] ?? {})
  .filter(([key]) => key.startsWith("electron:onboarding-") || key === "last_completed_onboarding"));
await writeFile(path.join(codexTestHome, ".codex-global-state.json"), JSON.stringify({
  "electron-persisted-atom-state": onboarding,
  "electron-saved-workspace-roots": [runtime],
  "active-workspace-roots": [runtime],
}), {mode:0o600});
const token = randomBytes(32).toString("hex");
const port = baselineUIOnly ? 28217 : 28216;
const origin = new URL(
  `http://download-${path.basename(runtime)}.localhost:${port}`,
).origin;
const sourceDocument = path.join(runtime, "下载验证-文件.txt");
await writeFile(sourceDocument, "Codex Web 中文下载验证\n", { mode: 0o600 });
const sourceImage = path.join(
  root,
  "scratch/asar/webview/assets/pwa-icon-512.png",
);
let server, relay, socket, browserContextId, remoteDownloads;
const serverLog = await open(path.join(runtime, "shadow.log"), "w", 0o600);
const pages = [];
const calls = new Map(),
  frames = new Set(),
  downloads = [],
  exceptions = [],
  network = [],
  logErrors = [];
let requestId = 0;
const results = [];
function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      calls.delete(id);
      reject(new Error(`${method} timed out`));
    }, 30000);
    calls.set(id, { resolve, reject, timer });
    socket.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
  });
}
async function until(check, description, duration = 60000) {
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${description}`);
}
async function evaluate(sessionId, expression, userGesture = false) {
  const value = await cdp(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, userGesture },
    sessionId,
  );
  if (value.exceptionDetails)
    throw new Error(
      `Browser evaluation failed: ${value.exceptionDetails.exception?.description?.slice(0, 500)}`,
    );
  return value.result.value;
}
try {
  server = spawn(
    process.execPath,
    [
      path.join(root, "src/server/main.js"),
      "--host",
      "100.90.94.39",
      "--port",
      String(port),
    ],
    {
      cwd: baselineUIOnly ? runtime : root,
      detached: true,
      stdio: ["ignore", serverLog.fd, serverLog.fd],
      env: {
        ...process.env,
        CODEX_HOME: codexTestHome,
        CODEX_WEB_TOKEN: token,
        CODEX_CLI_PATH: process.env.CODEX_CLI_PATH || "codex",
        CODEX_WEB_DATA_DIR: path.join(runtime, "app"),
        CODEX_ELECTRON_USER_DATA_PATH: path.join(runtime, "app/userData"),
        CODEX_WEB_DOCUMENTS_DIR: path.join(runtime, "documents"),
        CODEX_WEB_UPLOAD_ROOT: path.join(runtime, "uploads"),
      },
    },
  );
  await until(
    async () => {
      if (server.exitCode !== null) throw new Error("shadow server exited");
      try {
        const res = await fetch(`http://100.90.94.39:${port}/`, {
          headers: { cookie: `codex_web_token=${token}` },
          signal: AbortSignal.timeout(1000),
        });
        await res.arrayBuffer();
        return res.status === 200;
      } catch {
        return false;
      }
    },
    "shadow readiness",
    20000,
  );
  for (const method of ["GET", "HEAD"]) {
    const res = await fetch(
      `http://100.90.94.39:${port}/@fs${sourceDocument.split("/").map(encodeURIComponent).join("/")}?download=1`,
      { method },
    );
    assert.equal(res.status, 401);
    await res.arrayBuffer();
  }
  const relaySource = await readFile(
    path.join(root, "scripts/perf-loopback-proxy.py"),
    "utf8",
  );
  assert.ok(relaySource.includes("[(28214, 28214), (28215, 8214)]"));
  relay = spawn(
    "docker",
    [
      "exec",
      "-i",
      "chromium-cdp-forwarder",
      "python3",
      "-u",
      "-c",
      relaySource.replace(
        "[(28214, 28214), (28215, 8214)]",
        `[(${port}, ${port})]`,
      ),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("isolated relay timeout")),
      5000,
    );
    relay.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
    relay.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("isolated relay exited"));
    });
  });
  const version = await (
    await fetch("http://100.90.94.39:39222/json/version")
  ).json();
  const endpoint = new URL(version.webSocketDebuggerUrl);
  endpoint.hostname = "100.90.94.39";
  endpoint.port = "39222";
  socket = new WebSocket(endpoint);
  socket.on("message", (raw) => {
    const event = JSON.parse(raw);
    if (event.id && calls.has(event.id)) {
      const call = calls.get(event.id);
      calls.delete(event.id);
      clearTimeout(call.timer);
      if (event.error) call.reject(new Error(event.error.message));
      else call.resolve(event.result);
    } else if (
      event.method === "Browser.downloadWillBegin" &&
      frames.has(event.params.frameId)
    ) {
      downloads.push({ ...event.params, completed: false });
    } else if (event.method === "Browser.downloadProgress") {
      const row = downloads.find((item) => item.guid === event.params.guid);
      if (row) {
        row.state = event.params.state;
        row.completed = row.state === "completed";
        row.bytes = event.params.receivedBytes;
      }
    } else if (
      event.method === "Runtime.consoleAPICalled" &&
      event.params.type === "error"
    ) {
      logErrors.push(
        event.params.args.map((arg) =>
          String(arg.description ?? arg.value ?? "").slice(0, 1200),
        ),
      );
    } else if (event.method === "Runtime.exceptionThrown") {
      exceptions.push({
        sessionId: event.sessionId,
        name: event.params.exceptionDetails.exception?.className,
        text: event.params.exceptionDetails.text,
      });
    } else if (
      event.method === "Network.requestWillBeSent" &&
      event.params.request.url.includes("/@fs")
    ) {
      network.push({
        sessionId: event.sessionId,
        method: event.params.request.method,
      });
    }
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  browserContextId = (await cdp("Target.createBrowserContext"))
    .browserContextId;
  remoteDownloads = execFileSync(
    "docker",
    [
      "exec",
      "--user",
      "abc",
      "chromium",
      "mktemp",
      "-d",
      "/tmp/codex-download-check.XXXXXX",
    ],
    { encoding: "utf8" },
  ).trim();
  assert.match(remoteDownloads, /^\/tmp\/codex-download-check\.[A-Za-z0-9]+$/);
  await cdp("Browser.setDownloadBehavior", {
    behavior: "allowAndName",
    browserContextId,
    downloadPath: remoteDownloads,
    eventsEnabled: true,
  });
  for (let index = 0; index < 2; index++) {
    const { targetId } = await cdp("Target.createTarget", {
      url: "about:blank",
      browserContextId,
      background: true,
    });
    const { sessionId } = await cdp("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    for (const domain of ["Page", "Runtime", "Network"])
      await cdp(`${domain}.enable`, {}, sessionId);
    await cdp(
      "Network.setCookie",
      {
        name: "codex_web_token",
        value: token,
        url: origin,
        httpOnly: true,
        sameSite: "Lax",
      },
      sessionId,
    );
    const { frameId } = await cdp("Page.navigate", { url: origin }, sessionId);
    frames.add(frameId);
    pages.push({ targetId, sessionId, frameId });
  }
  const asset = `${origin}/assets/__build/${build}/app-shared-59042e7300f7.js`;
  for (const page of pages) {
    await until(
      () =>
        evaluate(
          page.sessionId,
          `(async()=>{if(!${baselineUIOnly}&&!window.__ELECTRON_SHIM__?.wrapBrowserServices)return false;const mod=await import(${JSON.stringify(asset)});return !!mod.$k?.workspaceFiles?.saveCopy;})()`,
        ),
      "actual app-host service initialization",
      90000,
    );
  }
  console.log(
    JSON.stringify({
      stage: "browser-ready",
      build,
      shadowPid: server.pid,
      tabs: pages.length,
      runtime,
    }),
  );
  for (const [kind, input, expected] of baselineUIOnly
    ? []
    : [
        [
          "text",
          { hostId: "local", path: sourceDocument },
          await readFile(sourceDocument),
        ],
        [
          "png",
          { hostId: "local", path: sourceImage },
          await readFile(sourceImage),
        ],
        [
          "browser-bytes",
          { bytes: [0, 1, 255, 0, 42], fileName: "浏览器内容.bin" },
          Buffer.from([0, 1, 255, 0, 42]),
        ],
        ["empty-bytes", { bytes: [], fileName: "空内容.txt" }, Buffer.alloc(0)],
      ]) {
    const before = downloads.length;
    const requestStart = network.length;
    const result = await evaluate(
      pages[0].sessionId,
      `(async()=>{const mod=await import(${JSON.stringify(asset)});return mod.$k.workspaceFiles.saveCopy(${JSON.stringify(input)});})()`,
      true,
    );
    assert.deepEqual(result, { path: null, downloadStarted: true });
    const download = await until(
      () => downloads[before]?.completed && downloads[before],
      `${kind} browser download`,
    );
    assert.equal(download.frameId, pages[0].frameId);
    assert.equal(downloads.length, before + 1);
    assert.equal(
      download.suggestedFilename,
      input.fileName ?? path.basename(input.path),
    );
    const downloadedHash = execFileSync(
      "docker",
      ["exec", "chromium", "sha256sum", `${remoteDownloads}/${download.guid}`],
      { encoding: "utf8" },
    ).split(/\s/)[0];
    assert.equal(downloadedHash, hash(expected));
    const requests = network.slice(requestStart);
    // Chromium can handle attachment GETs outside the renderer Network domain.
    // The completed Browser download plus on-disk digest verify that transfer.
    if (input.path) {
      assert.equal(requests[0]?.method, "HEAD");
      assert.ok(
        requests.every(
          (r) =>
            ["HEAD", "GET"].includes(r.method) &&
            r.sessionId === pages[0].sessionId,
        ),
      );
      assert.ok(download.url.startsWith(`${origin}/@fs/`));
    } else assert.equal(requests.length, 0);
    results.push({
      kind,
      filename: download.suggestedFilename,
      bytes: expected.length,
      sha256: downloadedHash,
      originatingTabOnly: true,
      requests: requests.map((r) => r.method),
    });
  }
  const beforeFailures = downloads.length;
  for (const input of baselineUIOnly
    ? []
    : [
        { hostId: "remote-test", path: sourceDocument },
        { path: "/not-present/codex-download-test" },
      ]) {
    const result = await evaluate(
      pages[0].sessionId,
      `(async()=>{const mod=await import(${JSON.stringify(asset)});try{await mod.$k.workspaceFiles.saveCopy(${JSON.stringify(input)});return {rejected:false}}catch(e){return {rejected:true,message:window.__ELECTRON_SHIM__.downloadErrorMessage(e)}}})()`,
    );
    assert.equal(result.rejected, true);
    assert.ok(result.message);
  }
  assert.equal(downloads.length, beforeFailures);
  const after = await Promise.all(
    configFiles.map(async (name) =>
      hash(await readFile(path.join("/home/ml/.codex", name))),
    ),
  );
  assert.deepEqual(after, configHashes);
  const ui = await until(
    () =>
      evaluate(
        pages[0].sessionId,
        `(()=>{const editors=document.querySelectorAll('.ProseMirror[contenteditable="true"]');if(editors.length)return {editorCount:editors.length,secureContext:isSecureContext};const heading=document.querySelector('h1');if(!heading?.textContent?.includes('hit a snag'))return false;let fiber=heading[Object.keys(heading).find(key=>key.startsWith('__reactFiber'))];const errors=[];for(let depth=0;fiber&&depth<50;depth++,fiber=fiber.return){const error=fiber.memoizedState?.error;if(error)errors.push(String(error.stack??error.message??error).slice(0,1600));}return {errorBoundary:true,errors};})()`,
      ),
    "full editor rendering",
    60000,
  );
  if (!ui.editorCount) throw new Error(JSON.stringify(ui));
  const report = {
    build,
    results,
    ui,
    exceptions,
    productionConfigUnchanged: true,
    shadowOnly: true,
  };
  await writeFile(
    path.join(runtime, "verification.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      passed: true,
      ...report,
      report: path.join(runtime, "verification.json"),
    }),
  );
} finally {
  let pageState;
  if (pages[0] && socket?.readyState === WebSocket.OPEN)
    pageState = await evaluate(
      pages[0].sessionId,
      `(()=>{const heading=Array.from(document.querySelectorAll('h1,[role="heading"]')).find(el=>el.textContent?.includes('snag'));let fiber=heading?.[Object.keys(heading??{}).find(key=>key.startsWith('__reactFiber'))];const errors=[];for(let depth=0;fiber&&depth<60;depth++,fiber=fiber.return){const state=fiber.memoizedState;if(state&&typeof state==='object'){for(const key of Object.keys(state)){const value=state[key];if(value instanceof Error)errors.push({key,message:String(value.stack??value).slice(0,1600)});}}}return {text:document.body?.innerText?.slice(0,1200),errors}})()`,
    ).catch(() => null);
  await writeFile(
    path.join(runtime, "diagnostic.json"),
    JSON.stringify(
      { build, results, exceptions, logErrors, pageState },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  if (browserContextId && socket?.readyState === WebSocket.OPEN)
    await cdp("Target.disposeBrowserContext", { browserContextId }).catch(
      () => {},
    );
  socket?.close();
  relay?.stdin.end();
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
  }
  if (server)
    await until(
      () => server.exitCode !== null || server.signalCode !== null,
      "shadow stop",
      5000,
    ).catch(() => {});
  for (const name of configFiles)
    await unlink(path.join(codexTestHome, name)).catch(() => {});
  await serverLog.close();
  await unlink(path.join(runtime, "shadow.log")).catch(() => {});
  if (remoteDownloads) {
    assert.match(remoteDownloads, /^\/tmp\/codex-download-check\.[A-Za-z0-9]+$/);
    execFileSync("docker", ["exec", "chromium", "rm", "-rf", "--", remoteDownloads]);
  }
  for (const call of calls.values()) clearTimeout(call.timer);
  // Keep evidence and isolated runtime private on the data disk. No production paths are removed.
  console.log(
    JSON.stringify({ shadowStopped: true, runtime, remoteDownloads }),
  );
}
