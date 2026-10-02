// Run inside the currently deployed container before replacing its app-server.
// Only status metadata is read; prompts, tool output and credentials are never logged.
async function readActivity(request) {
  const loaded = await request("thread/loaded/list", {});
  if (!Array.isArray(loaded.data))
    throw new Error("Invalid loaded-thread response");
  let active = 0;
  for (const threadId of loaded.data) {
    const { thread } = await request("thread/read", {
      threadId,
      includeTurns: false,
    });
    const status = thread?.status?.type;
    if (!["active", "idle", "notLoaded", "systemError"].includes(status))
      throw new Error("Cannot establish thread activity");
    if (status === "active") active++;
  }
  return { loaded: loaded.data.length, active };
}

async function main() {
  const { createRequire } = require("node:module");
  const WebSocket = createRequire("/app/package.json")("ws");
  const socket = new WebSocket("ws://127.0.0.1:8214/__backend/ipc", {
    headers: { Cookie: `codex_web_token=${process.env.CODEX_WEB_TOKEN}` },
  });
  const waiting = new Map();
  let sequence = 0;
  socket.on("message", (raw) => {
    const envelope = JSON.parse(raw);
    if (envelope.type === "ipc-renderer-invoke-result" && !envelope.ok) {
      const pending = waiting.get(envelope.requestId);
      pending?.reject(new Error("Activity request could not be delivered"));
      return;
    }
    const body = envelope.type === "ipc-main-event" && envelope.args?.[0];
    if (body?.type !== "mcp-response") return;
    const pending = waiting.get(body.message.id);
    if (!pending) return;
    body.message.error
      ? pending.reject(new Error("Activity request failed"))
      : pending.resolve(body.message.result);
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `release-idle-${++sequence}`;
      const timer = setTimeout(
        () => finish(new Error("Activity request timed out")),
        15_000,
      );
      const finish = (error, result) => {
        clearTimeout(timer);
        waiting.delete(id);
        error ? reject(error) : resolve(result);
      };
      waiting.set(id, {
        resolve: (result) => finish(null, result),
        reject: finish,
      });
      socket.send(
        JSON.stringify({
          type: "ipc-renderer-invoke",
          requestId: id,
          channel: "codex_desktop:message-from-view",
          args: [
            {
              type: "mcp-request",
              hostId: "local",
              request: { id, method, params },
            },
          ],
        }),
      );
    });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Activity connection timed out")),
        15_000,
      );
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Activity connection failed"));
      });
    });
    const deadline = Date.now() + 60 * 60_000;
    let stable = 0;
    while (Date.now() < deadline) {
      const activity = await readActivity(request);
      console.log(JSON.stringify({ phase: "waiting-for-idle", ...activity }));
      stable = activity.active === 0 ? stable + 1 : 0;
      if (stable >= 3) return;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    throw new Error("Active tasks still present; deployment was not started");
  } finally {
    socket.close();
    setTimeout(() => socket.terminate(), 1000).unref();
  }
}

module.exports = { readActivity };
// kubectl pipes this file to `node`; stdin modules have no require.main.
if (!module.parent)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
