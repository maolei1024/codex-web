import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { initializeContainer } from "/app/scripts/container-init.mjs";
import { nativeAppHostRuntime } from "./desktop-app-host-harness.mjs";
import { nativeChunkedRuntime } from "./desktop-chunked-message-harness.mjs";

const require = createRequire("/app/package.json");
const release = require("/app/local-build.json");
assert.equal(
  require("/app/scratch/asar/package.json").version,
  release.desktopVersion,
);
assert.equal(
  execFileSync(process.env.CODEX_CLI_PATH || "codex", ["--version"], {
    encoding: "utf8",
  }).trim(),
  `codex-cli ${release.codexCliVersion}`,
);
assert.equal(require("/app/src/server/electron/index.js").net.isOnline(), true);
for (const sound of ["codex-notification.wav", "codex-classic.wav"]) {
  const bytes = await readFile(`/app/scratch/asar/${sound}`);
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  assert.ok(bytes.length > 44, `${sound} must contain packaged audio`);
}
// OpenSSH resolves ~/.ssh from passwd, independently of the HOME environment.
assert.equal(
  execFileSync("getent", ["passwd", String(process.getuid())], {
    encoding: "utf8",
  })
    .trim()
    .split(":")[5],
  process.env.HOME,
);
const Database = require("better-sqlite3");
const db = new Database(":memory:");
assert.equal(db.prepare("select 1 as n").get().n, 1);
db.close();
assert.equal(typeof require("@parcel/watcher").subscribe, "function");
const WebSocket = require("ws");
const { Reassembler } = await nativeChunkedRuntime();
const root = await mkdtemp(`${tmpdir()}/codex-web-smoke-`);
const env = {
  ...process.env,
  HOME: `${root}/home`,
  CODEX_HOME: `${root}/codex`,
  CODEX_WEB_DATA_DIR: `${root}/app`,
  CODEX_ELECTRON_USER_DATA_PATH: `${root}/app/userData`,
  CODEX_WEB_DOCUMENTS_DIR: `${root}/documents`,
  CODEX_WEB_UPLOAD_ROOT: `${root}/uploads`,
  CODEX_WEB_TOKEN: "container-smoke-only",
};
await initializeContainer(env);
const workspaceRoots = [`${env.CODEX_WEB_DOCUMENTS_DIR}/ChatGPT`];
await writeFile(
  `${env.CODEX_HOME}/.codex-global-state.json`,
  JSON.stringify({ "electron-saved-workspace-roots": workspaceRoots }),
);
const clients = new Set();
async function connectClient(headers) {
  const socket = new WebSocket("ws://127.0.0.1:18214/__backend/ipc", {
    headers,
  });
  const events = new EventEmitter();
  const receiver = new Reassembler();
  const client = { socket, events };
  clients.add(client);
  socket.on("error", (error) => events.emit("failure", error));
  socket.on("close", () => {
    clients.delete(client);
    events.emit("closed");
  });
  socket.on("message", (raw) => {
    try {
      let envelope = JSON.parse(raw);
      if (
        envelope.type === "ipc-main-event" &&
        envelope.channel === "codex_desktop:message-for-view"
      ) {
        const received = receiver.receive(envelope.args?.[0]);
        if (received.acknowledgement && socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              type: "ipc-renderer-send",
              channel: "codex_desktop:chunked-message-ack",
              args: [
                received.acknowledgement.transferId,
                received.acknowledgement.sequence,
              ],
            }),
          );
        }
        if (received.type === "pending") return;
        envelope = { ...envelope, args: [received.message] };
      }
      events.emit("message", envelope);
    } catch (error) {
      events.emit("failure", error);
      socket.terminate();
    }
  });
  let timer;
  try {
    await Promise.race([
      once(socket, "open"),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("WebSocket timeout")), 10_000);
      }),
    ]);
    return client;
  } catch (error) {
    socket.terminate();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function closeClient(client) {
  if (client.socket.readyState === WebSocket.CLOSED) return;
  const closed = once(client.socket, "close");
  client.socket.close();
  const timer = setTimeout(() => client.socket.terminate(), 1000);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}
function readGlobalState(client, label) {
  return new Promise((resolve, reject) => {
    const requestId = `smoke-global-state-${label}`;
    const invokeId = `${requestId}-invoke`;
    const finish = (error) => {
      clearTimeout(timer);
      client.events.off("message", received);
      client.events.off("failure", failed);
      client.events.off("closed", disconnected);
      error ? reject(error) : resolve();
    };
    const failed = (error) => finish(error);
    const disconnected = () =>
      finish(new Error("Global state client disconnected"));
    const received = (envelope) => {
      if (
        envelope.type === "ipc-renderer-invoke-result" &&
        envelope.requestId === invokeId &&
        !envelope.ok
      ) {
        finish(new Error(envelope.errorMessage));
        return;
      }
      const message = envelope.type === "ipc-main-event" && envelope.args?.[0];
      if (message?.type !== "fetch-response" || message.requestId !== requestId)
        return;
      try {
        assert.equal(message.responseType, "success");
        assert.equal(message.status, 200);
        assert.deepEqual(
          JSON.parse(message.bodyJsonString).value,
          workspaceRoots,
        );
        finish();
      } catch (error) {
        finish(error);
      }
    };
    const timer = setTimeout(
      () => finish(new Error(`Native global state timeout: ${label}`)),
      15_000,
    );
    client.events.on("message", received);
    client.events.on("failure", failed);
    client.events.on("closed", disconnected);
    client.socket.send(
      JSON.stringify({
        type: "ipc-renderer-invoke",
        requestId: invokeId,
        channel: "codex_desktop:message-from-view",
        args: [
          {
            type: "fetch",
            requestId,
            url: "vscode://codex/get-global-state",
            body: JSON.stringify({ key: "electron-saved-workspace-roots" }),
          },
        ],
      }),
    );
  });
}
const child = spawn(
  process.execPath,
  ["/app/src/server/main.js", "--host", "127.0.0.1", "--port", "18214"],
  {
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let diagnosticOutput = "";
for (const output of [child.stdout, child.stderr]) {
  output.on("data", (chunk) => {
    diagnosticOutput = (diagnosticOutput + chunk).slice(-16_000);
  });
}
const exited = once(child, "exit");
async function processIdentity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, parent: Number(fields[1]), started: fields[19] };
  } catch {
    return null;
  }
}
try {
  const url = "http://127.0.0.1:18214";
  let response;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`Packaged server exited: ${child.exitCode}`);
    try {
      response = await fetch(url);
      break;
    } catch {
      await delay(500);
    }
  }
  assert.equal(response?.status, 401);
  const headers = { Cookie: "codex_web_token=container-smoke-only" };
  assert.equal((await fetch(url, { headers })).status, 200);
  let client = await connectClient(headers);
  let socket = client.socket;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Desktop app-server initialization timeout")),
      60_000,
    );
    const sendRequest = () => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            type: "ipc-renderer-invoke",
            requestId: "smoke-invoke",
            channel: "codex_desktop:message-from-view",
            args: [
              {
                type: "mcp-request",
                hostId: "local",
                request: {
                  id: "smoke-thread-list",
                  method: "thread/list",
                  params: { limit: 1 },
                },
              },
            ],
          }),
        );
    };
    client.events.on("message", (envelope) => {
      if (
        envelope.type === "ipc-renderer-invoke-result" &&
        envelope.requestId === "smoke-invoke" &&
        !envelope.ok
      ) {
        if (envelope.errorMessage.includes("No ipcMain.handle"))
          setTimeout(sendRequest, 100);
        else {
          clearTimeout(timer);
          reject(new Error(envelope.errorMessage));
        }
        return;
      }
      const message = envelope.type === "ipc-main-event" && envelope.args?.[0];
      if (
        message?.type === "mcp-response" &&
        message.message.id === "smoke-thread-list"
      ) {
        clearTimeout(timer);
        if (message.message.error)
          reject(new Error(JSON.stringify(message.message.error)));
        else {
          try {
            assert.ok(Array.isArray(message.message.result.data));
            resolve();
          } catch (error) {
            reject(error);
          }
        }
      }
    });
    sendRequest();
  });
  // Ordinary Desktop fetches must work on separate windows and after replacing
  // a connection; the direct shared-object snapshot cannot cover this queue.
  const second = await connectClient(headers);
  await Promise.all([
    readGlobalState(client, "a"),
    readGlobalState(second, "b"),
  ]);
  await closeClient(client);
  client = await connectClient(headers);
  socket = client.socket;
  await Promise.all([
    readGlobalState(client, "a-reconnected"),
    readGlobalState(second, "b-after-a-close"),
  ]);
  // Exercise the same extracted RPC engine as Chrome, not merely IPC thread/list.
  const rpc = await nativeAppHostRuntime();
  const { port1, port2 } = new MessageChannel();
  port2.start();
  port2.on("message", (data) => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          type: "message-port-message",
          portId: "smoke-host",
          data,
        }),
      );
  });
  const route = (envelope) => {
    if (envelope.portId !== "smoke-host") return;
    if (envelope.type === "message-port-message")
      port2.postMessage(envelope.data);
    if (envelope.type === "message-port-close") port2.postMessage(null);
  };
  client.events.on("message", route);
  const view = new (class extends rpc.Target {
    get services() {
      return {
        appUpdates: { stateChanged() {} },
        downloads: { stateChanged() {} },
        clientCoordination: {},
      };
    }
  })();
  const host = rpc.connect(port1, view);
  socket.send(
    JSON.stringify({
      type: "ipc-renderer-post-message",
      channel: "codex_desktop:connect-app-host",
      message: {},
      portIds: ["smoke-host"],
    }),
  );
  let settingsTimer;
  try {
    const settings = await Promise.race([
      (async () => {
        const services = await host.services;
        assert.equal(
          (await services.appInfo.get()).version,
          release.desktopVersion,
        );
        await services.browserHost.getExtensionCounts();
        const subscription = await services.accessInputs.subscribe(() => {});
        subscription[Symbol.dispose]();
        return await services.settings.readAll();
      })(),
      new Promise((_, reject) => {
        settingsTimer = setTimeout(
          () => reject(new Error("AppHost settings timeout")),
          15_000,
        );
      }),
    ]);
    assert.ok(
      settings.values && settings.configuredValues,
      "AppHost must return native settings",
    );
    assert.ok(Object.keys(settings.values).length > 0);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.events.off("message", received);
        reject(new Error("Initial snapshot timeout"));
      }, 15_000);
      const received = (envelope) => {
        if (envelope.requestId !== "smoke-snapshot") return;
        clearTimeout(timer);
        client.events.off("message", received);
        try {
          assert.equal(envelope.ok, true);
          assert.ok(envelope.result.host_config);
          assert.equal("statsig_evaluations" in envelope.result, false);
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      client.events.on("message", received);
      socket.send(
        JSON.stringify({
          type: "ipc-renderer-invoke",
          requestId: "smoke-snapshot",
          channel: "codex_desktop:get-shared-object-snapshot",
          args: [],
        }),
      );
    });
  } finally {
    clearTimeout(settingsTimer);
    host[Symbol.dispose]();
    await delay(50);
    port1.close();
    port2.close();
    client.events.off("message", route);
    await Promise.all([closeClient(client), closeClient(second)]);
  }
  await delay(2000);
  assert.equal(child.exitCode, null, "Desktop bridge must remain running");
  console.log(
    `Container smoke passed: ${process.arch}, native addons, authentication, WebSocket, native state across connections, AppHost settings, Desktop startup`,
  );
} catch (error) {
  console.error(diagnosticOutput);
  throw error;
} finally {
  await Promise.allSettled([...clients].map(closeClient));
  // Git helpers can create their own process groups; stop the complete test
  // subtree before removing its state. Never kill a PID that has been reused.
  const processes = (
    await Promise.all(
      (await readdir("/proc"))
        .filter((name) => /^\d+$/.test(name))
        .map((pid) => processIdentity(Number(pid))),
    )
  ).filter(Boolean);
  const owned = new Set([child.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes)
      if (owned.has(process.parent) && !owned.has(process.pid)) {
        owned.add(process.pid);
        changed = true;
      }
  }
  const stop = async (signal) => {
    for (const entry of processes
      .filter((entry) => owned.has(entry.pid))
      .reverse()) {
      if ((await processIdentity(entry.pid))?.started === entry.started) {
        try {
          process.kill(entry.pid, signal);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    }
  };
  await stop("SIGTERM");
  await exited;
  await delay(200);
  await stop("SIGKILL");
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
