import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { initializeContainer } from "/app/scripts/container-init.mjs";

const require = createRequire("/app/package.json");
assert.equal(require("/app/src/server/electron/index.js").net.isOnline(), true);
// OpenSSH resolves ~/.ssh from passwd, independently of the HOME environment.
assert.equal(execFileSync("getent", ["passwd", String(process.getuid())], { encoding: "utf8" }).trim().split(":")[5], process.env.HOME);
const Database = require("better-sqlite3");
const db = new Database(":memory:");
assert.equal(db.prepare("select 1 as n").get().n, 1);
db.close();
assert.equal(typeof require("@parcel/watcher").subscribe, "function");
const WebSocket = require("ws");
const root = await mkdtemp(`${tmpdir()}/codex-web-smoke-`);
const env = {
  ...process.env, HOME: `${root}/home`, CODEX_HOME: `${root}/codex`,
  CODEX_WEB_DATA_DIR: `${root}/app`, CODEX_ELECTRON_USER_DATA_PATH: `${root}/app/userData`,
  CODEX_WEB_DOCUMENTS_DIR: `${root}/documents`, CODEX_WEB_UPLOAD_ROOT: `${root}/uploads`,
  CODEX_WEB_TOKEN: "container-smoke-only",
};
await initializeContainer(env);
const child = spawn(process.execPath, ["/app/src/server/main.js", "--host", "127.0.0.1", "--port", "18214"], {
  env, detached: true, stdio: ["ignore", "pipe", "pipe"],
});
let diagnosticOutput = "";
for (const output of [child.stdout, child.stderr]) {
  output.on("data", (chunk) => { diagnosticOutput = (diagnosticOutput + chunk).slice(-16_000); });
}
const exited = once(child, "exit");
async function processIdentity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, parent: Number(fields[1]), started: fields[19] };
  } catch { return null; }
}
try {
  const url = "http://127.0.0.1:18214";
  let response;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Packaged server exited: ${child.exitCode}`);
    try { response = await fetch(url); break; } catch { await delay(500); }
  }
  assert.equal(response?.status, 401);
  const headers = { Cookie: "codex_web_token=container-smoke-only" };
  assert.equal((await fetch(url, { headers })).status, 200);
  const socket = new WebSocket("ws://127.0.0.1:18214/__backend/ipc", { headers });
  await Promise.race([once(socket, "open"), delay(10_000).then(() => { throw new Error("WebSocket timeout"); })]);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Desktop app-server initialization timeout")), 60_000);
    const sendRequest = () => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ipc-renderer-invoke", requestId: "smoke-invoke", channel: "codex_desktop:message-from-view", args: [{ type: "mcp-request", hostId: "local", request: { id: "smoke-thread-list", method: "thread/list", params: { limit: 1 } } }] }));
    };
    socket.on("message", (raw) => {
      const envelope = JSON.parse(raw);
      if (envelope.type === "ipc-renderer-invoke-result" && envelope.requestId === "smoke-invoke" && !envelope.ok) {
        if (envelope.errorMessage.includes("No ipcMain.handle")) setTimeout(sendRequest, 100);
        else { clearTimeout(timer); reject(new Error(envelope.errorMessage)); }
        return;
      }
      const message = envelope.type === "ipc-main-event" && envelope.args?.[0];
      if (message?.type === "mcp-response" && message.message.id === "smoke-thread-list") {
        clearTimeout(timer);
        if (message.message.error) reject(new Error(JSON.stringify(message.message.error)));
        else {
          try { assert.ok(Array.isArray(message.message.result.data)); resolve(); }
          catch (error) { reject(error); }
        }
      }
    });
    sendRequest();
  });
  socket.close();
  await delay(2000);
  assert.equal(child.exitCode, null, "Desktop bridge must remain running");
  console.log(`Container smoke passed: ${process.arch}, native addons, authentication, WebSocket, Desktop startup`);
} catch (error) {
  console.error(diagnosticOutput);
  throw error;
} finally {
  // Git helpers can create their own process groups; stop the complete test
  // subtree before removing its state. Never kill a PID that has been reused.
  const processes = (await Promise.all((await readdir("/proc"))
    .filter((name) => /^\d+$/.test(name)).map((pid) => processIdentity(Number(pid)))))
    .filter(Boolean);
  const owned = new Set([child.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) if (owned.has(process.parent) && !owned.has(process.pid)) {
      owned.add(process.pid); changed = true;
    }
  }
  const stop = async (signal) => {
    for (const entry of processes.filter((entry) => owned.has(entry.pid)).reverse()) {
      if ((await processIdentity(entry.pid))?.started === entry.started) {
        try { process.kill(entry.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
  };
  await stop("SIGTERM");
  await exited;
  await delay(200);
  await stop("SIGKILL");
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
