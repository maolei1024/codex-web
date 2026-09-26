import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { initializeContainer } from "/app/scripts/container-init.mjs";

const require = createRequire("/app/package.json");
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
const child = spawn(process.execPath, ["/app/src/server/main.js", "server", "--host", "127.0.0.1", "--port", "18214"], {
  env, detached: true, stdio: "ignore",
});
const exited = once(child, "exit");
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
  socket.close();
  await delay(2000);
  assert.equal(child.exitCode, null, "Desktop bridge must remain running");
  console.log(`Container smoke passed: ${process.arch}, native addons, authentication, WebSocket, Desktop startup`);
} finally {
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await exited;
  await rm(root, { recursive: true, force: true });
}
