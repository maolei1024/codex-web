#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envText = await readFile("/home/ml/.config/codex-web/env", "utf8");
let token = envText.match(/^CODEX_WEB_TOKEN=(.*)$/m)?.[1]?.trim();
if (token?.startsWith('"') || token?.startsWith("'"))
  token = token.slice(1, -1);
if (!token) throw new Error("codex-web authentication unavailable");
const paths = ["/home/ml/.codex/config.toml", "/home/ml/.codex/auth.json"];
async function fingerprints() {
  return Promise.all(
    paths.map(async (filename) =>
      createHash("sha256")
        .update(await readFile(filename))
        .digest("hex"),
    ),
  );
}
const before = await fingerprints();
const server = spawn(
  process.execPath,
  ["src/server/main.js", "--host", "100.90.94.39", "--port", "28214"],
  {
    cwd: root,
    env: {
      ...process.env,
      CODEX_WEB_TOKEN: token,
      CODEX_CLI_PATH: "/home/ml/.local/node-v22.22.0/bin/codex",
      CODEX_WEB_UPLOAD_ROOT:
        "/srv/docker-data/codex-maintenance/tmp/perf-uploads-20260907",
    },
    stdio: "ignore",
    detached: true,
  },
);
let relay;
try {
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (server.exitCode !== null)
      throw new Error(`shadow exited: ${server.exitCode}`);
    try {
      const response = await fetch("http://100.90.94.39:28214/", {
        headers: { cookie: `codex_web_token=${token}` },
        signal: AbortSignal.timeout(1000),
      });
      await response.arrayBuffer();
      if (response.status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error("shadow not ready");
  const code = await readFile(
    path.join(root, "scripts/perf-loopback-proxy.py"),
    "utf8",
  );
  relay = spawn(
    "docker",
    ["exec", "-i", "chromium-cdp-forwarder", "python3", "-u", "-c", code],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("browser relay not ready")),
      5000,
    );
    relay.stdout.once("data", () => {
      clearTimeout(timeout);
      resolve();
    });
    relay.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error("browser relay exited"));
    });
  });
  console.log(
    JSON.stringify({
      fixtureReady: true,
      shadowPid: server.pid,
      baseline: "http://localhost:28215/",
      candidate: "http://localhost:28214/",
    }),
  );
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  relay?.stdin.end();
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
  console.log(
    JSON.stringify({
      fixtureStopped: true,
      productionCredentialsAndConfigUnchanged:
        JSON.stringify(before) === JSON.stringify(await fingerprints()),
    }),
  );
}
