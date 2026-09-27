import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import test from "node:test";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
const {
  parseServerArgs,
  startIpcBridgeServer,
} = require("../src/server/main.js");

const TOKEN = "integration-secret";

const LOCAL_BUILD = JSON.parse(await readFile("local-build.json", "utf8")).id;

function options(overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    maxUploadBytes: 16,
    maxUploadRequestBytes: 24,
    maxUploadFiles: 2,
    maxUploadDiskBytes: 64,
    uploadTtlMs: 60_000,
    maxConcurrentUploads: 2,
    uploadRootDir: os.tmpdir(),
    ...overrides,
  };
}

function requestRaw(port, requestPath, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: requestPath, headers, method },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function openWebSocket(url, headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function rejectedWebSocketStatus(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode);
      response.resume();
    });
    socket.once("open", () =>
      reject(new Error("websocket unexpectedly opened")),
    );
    socket.once("error", () => {});
  });
}

function closeWebSocket(socket) {
  return new Promise((resolve) => {
    socket.once("close", resolve);
    socket.close();
  });
}

test("shared objects stay within subscribing tabs and disconnect releases references", async () => {
  const bridge = (globalThis.__codexElectronIpcBridge ??= {});
  const previousHandler = bridge.handleRendererInvoke;
  const refs = new Map();
  const received = new Map();
  const clients = new Set();
  const channel = "codex_desktop:message-from-view";
  const eventChannel = "codex_desktop:message-for-view";
  const update = (key, value) =>
    bridge.broadcastToRenderer({
      type: "ipc-main-event",
      channel: eventChannel,
      args: [{ type: "shared-object-updated", key, value }],
    });
  bridge.handleRendererInvoke = async (_channel, [event]) => {
    if (event.type === "shared-object-subscribe") {
      refs.set(event.key, (refs.get(event.key) ?? 0) + 1);
      update(event.key, "initial snapshot");
    } else if (event.type === "shared-object-unsubscribe") {
      refs.set(event.key, (refs.get(event.key) ?? 0) - 1);
    } else if (event.type === "shared-object-set") {
      update(event.key, event.value);
    }
    return null;
  };
  const app = await startIpcBridgeServer(options(), {
    launchDesktopApp: false,
  });
  let sequence = 0;
  const connect = async () => {
    const socket = await openWebSocket(
      `ws://127.0.0.1:${app.server.address().port}/__backend/ipc?token=${TOKEN}`,
    );
    clients.add(socket);
    received.set(socket, []);
    socket.on("message", (data) => received.get(socket).push(JSON.parse(data)));
    return socket;
  };
  const invoke = (socket, event) =>
    new Promise((resolve, reject) => {
      const requestId = `subscription-test-${sequence++}`;
      const timer = setTimeout(
        () => reject(new Error("invoke timed out")),
        2000,
      );
      const listener = (data) => {
        const message = JSON.parse(data);
        if (message.requestId !== requestId) return;
        clearTimeout(timer);
        socket.off("message", listener);
        assert.equal(message.ok, true);
        resolve();
      };
      socket.on("message", listener);
      socket.send(
        JSON.stringify({
          type: "ipc-renderer-invoke",
          channel,
          requestId,
          args: [event],
        }),
      );
    });
  const events = (socket) =>
    received.get(socket).filter((m) => m.type === "ipc-main-event");
  const barrier = async () => {
    for (const socket of clients)
      await invoke(socket, { type: "test-barrier" });
  };
  try {
    const a = await connect(),
      b = await connect(),
      c = await connect();
    await invoke(a, {
      type: "shared-object-subscribe",
      key: "remote_ssh_connections",
    });
    await invoke(b, {
      type: "shared-object-subscribe",
      key: "remote_ssh_connections",
    });
    await invoke(a, {
      type: "shared-object-subscribe",
      key: "remote_ssh_connections",
    });
    await invoke(a, {
      type: "shared-object-subscribe",
      key: "statsig_evaluations",
    });
    await barrier();
    assert.equal(refs.get("remote_ssh_connections"), 3);
    assert.equal(
      events(b).filter((m) => m.args[0].key === "remote_ssh_connections")
        .length,
      2,
    );
    assert.equal(
      events(b).filter((m) => m.args[0].key === "statsig_evaluations").length,
      0,
    );
    assert.equal(events(c).length, 0);

    // A publisher need not subscribe to (or receive) its own multi-MB value.
    await invoke(c, {
      type: "shared-object-set",
      key: "statsig_evaluations",
      value: "x".repeat(100_000),
    });
    await barrier();
    assert.equal(events(a).at(-1).args[0].value.length, 100_000);
    assert.equal(events(c).length, 0);
    await invoke(c, {
      type: "shared-object-unsubscribe",
      key: "remote_ssh_connections",
    });
    assert.equal(refs.get("remote_ssh_connections"), 3);
    await invoke(a, {
      type: "shared-object-unsubscribe",
      key: "remote_ssh_connections",
    });
    await closeWebSocket(a);
    clients.delete(a);
    await barrier();
    assert.equal(refs.get("remote_ssh_connections"), 1);
    assert.equal(refs.get("statsig_evaluations"), 0);

    received.get(b).length = 0;
    received.get(c).length = 0;
    update("remote_ssh_connections", "changed while another tab disconnected");
    update("statsig_evaluations", "nobody reads this");
    bridge.broadcastToRenderer({
      type: "ipc-main-event",
      channel: eventChannel,
      args: [{ type: "mcp-notification" }],
    });
    await barrier();
    assert.deepEqual(
      events(b).map((m) => m.args[0].type),
      ["shared-object-updated", "mcp-notification"],
    );
    assert.deepEqual(
      events(c).map((m) => m.args[0].type),
      ["mcp-notification"],
    );
    const reconnected = await connect();
    await invoke(reconnected, {
      type: "shared-object-subscribe",
      key: "remote_ssh_connections",
    });
    assert.equal(events(reconnected)[0].args[0].value, "initial snapshot");
    assert.equal(refs.get("remote_ssh_connections"), 2);
  } finally {
    for (const client of clients) await closeWebSocket(client);
    await app.close();
    bridge.handleRendererInvoke = previousHandler;
  }
});

test("server args accept environment and CLI upload limits", () => {
  const parsed = parseServerArgs(
    ["--port", "9000", "--max-upload-files", "3"],
    {
      CODEX_WEB_TOKEN: "secret",
      CODEX_WEB_MAX_UPLOAD_BYTES: "10",
      CODEX_WEB_MAX_UPLOAD_REQUEST_BYTES: "20",
      CODEX_WEB_MAX_UPLOAD_DISK_BYTES: "30",
      CODEX_WEB_UPLOAD_TTL_MS: "40",
      CODEX_WEB_MAX_CONCURRENT_UPLOADS: "2",
      CODEX_WEB_UPLOAD_ROOT: "/srv/uploads",
    },
  );
  assert.deepEqual(parsed, {
    host: "127.0.0.1",
    port: 9000,
    token: "secret",
    maxUploadBytes: 10,
    maxUploadRequestBytes: 20,
    maxUploadFiles: 3,
    maxUploadDiskBytes: 30,
    uploadTtlMs: 40,
    maxConcurrentUploads: 2,
    uploadRootDir: "/srv/uploads",
  });
});

test("HTTP, upload and WebSocket routes enforce auth and safe paths", async () => {
  const app = await startIpcBridgeServer(options(), {
    launchDesktopApp: false,
  });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  const origin = `http://127.0.0.1:${port}`;
  let uploadedPath;

  try {
    for (const route of ["/", "/manifest.json", "/assets/preload.js"]) {
      const response = await fetch(`${origin}${route}`, { redirect: "manual" });
      assert.equal(response.status, 401, route);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }

    for (const unsafePath of [
      "/%252e%252e/etc/passwd",
      "/a%5c..%5csecret",
      "/%ZZ",
      "//example.com/",
    ]) {
      const response = await requestRaw(port, unsafePath);
      assert.equal(response.status, 400, unsafePath);
    }

    const bootstrap = await fetch(`${origin}/?token=${TOKEN}&next=1`, {
      headers: { "x-forwarded-proto": "https" },
      redirect: "manual",
    });
    assert.equal(bootstrap.status, 302);
    assert.equal(bootstrap.headers.get("location"), "/?next=1");
    const setCookie = bootstrap.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Secure/);
    const cookie = setCookie.split(";", 1)[0];

    const root = await fetch(`${origin}/`, { headers: { cookie } });
    assert.equal(root.status, 200);

    const preload = await fetch(`${origin}/assets/preload.js`, {
      headers: { cookie, "accept-encoding": "br" },
    });
    assert.equal(preload.status, 200);
    assert.equal(preload.headers.get("cache-control"), "no-cache");
    assert.equal(preload.headers.get("content-encoding"), "br");

    const form = new FormData();
    form.append("files", new Blob(["hello"]), "hello.txt");
    const upload = await fetch(`${origin}/__backend/upload`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    assert.equal(upload.status, 200);
    const uploadBody = await upload.json();
    uploadedPath = uploadBody.files[0].fsPath;
    assert.equal(await readFile(uploadedPath, "utf8"), "hello");

    const oversizedForm = new FormData();
    oversizedForm.append("files", new Blob(["x".repeat(17)]), "large.txt");
    const oversized = await fetch(`${origin}/__backend/upload`, {
      method: "POST",
      headers: { cookie },
      body: oversizedForm,
    });
    assert.equal(oversized.status, 413);

    assert.equal(
      await rejectedWebSocketStatus(`ws://127.0.0.1:${port}/__backend/ipc`),
      401,
    );
    const cookieSocket = await openWebSocket(
      `ws://127.0.0.1:${port}/__backend/ipc`,
      { cookie },
    );
    await closeWebSocket(cookieSocket);
    const querySocket = await openWebSocket(
      `ws://127.0.0.1:${port}/__backend/ipc?token=${TOKEN}`,
    );
    await closeWebSocket(querySocket);
  } finally {
    await app.close();
  }

  await assert.rejects(readFile(uploadedPath));
});

test("versioned preload is immutable; unversioned preload revalidates and all assets enforce auth", async () => {
  const app = await startIpcBridgeServer(options(), {
    launchDesktopApp: false,
  });
  const port = app.server.address().port;
  const cookie = `codex_web_token=${TOKEN}`;
  try {
    for (const route of [
      "/assets/preload.js",
      "/assets/preload.js.map",
      `/assets/__build/${LOCAL_BUILD}/preload.js`,
      `/assets/__build/${LOCAL_BUILD}/preload.js.map`,
    ]) {
      const versioned = route.startsWith("/assets/__build/");
      assert.equal((await requestRaw(port, route)).status, 401);
      for (const encoding of ["identity", "br", "gzip"]) {
        const headers = { cookie, "accept-encoding": encoding };
        const first = await requestRaw(port, route, headers);
        assert.equal(first.status, 200, route);
        if (versioned)
          assert.match(
            first.headers["cache-control"],
            /max-age=31536000, immutable/,
          );
        else assert.equal(first.headers["cache-control"], "no-cache");
        for (const method of ["GET", "HEAD"]) {
          const cached = await requestRaw(
            port,
            route,
            { ...headers, "if-none-match": first.headers.etag },
            method,
          );
          assert.equal(cached.status, 304, `${route} ${method} ${encoding}`);
          if (versioned)
            assert.match(
              cached.headers["cache-control"],
              /max-age=31536000, immutable/,
            );
          else assert.equal(cached.headers["cache-control"], "no-cache");
          assert.equal(cached.body.length, 0);
        }
      }
    }
    const immutable = await requestRaw(
      port,
      `/assets/__build/${LOCAL_BUILD}/index-ff3baa300544.js`,
      { cookie },
    );
    assert.equal(immutable.status, 200);
    assert.match(immutable.headers["cache-control"], /immutable/);
    assert.equal(
      (await requestRaw(port, "/assets/__build/unknown/preload.js", { cookie }))
        .status,
      404,
    );
    assert.equal(
      (
        await requestRaw(
          port,
          `/assets/__build/${LOCAL_BUILD}/%252e%252e/etc/passwd`,
          { cookie },
        )
      ).status,
      400,
    );
    const html = await requestRaw(port, "/", { cookie });
    assert.ok(
      html.body
        .toString()
        .includes(`/assets/__build/${LOCAL_BUILD}/preload.js`),
    );
  } finally {
    await app.close();
  }
});

test("compressed and legacy WebSocket clients preserve large messages, ordering and reconnect", async () => {
  const app = await startIpcBridgeServer(options(), {
    launchDesktopApp: false,
  });
  const port = app.server.address().port;
  const bridge = globalThis.__codexElectronIpcBridge;
  const previous = bridge.handleRendererInvoke;
  bridge.handleRendererInvoke = async (_channel, args) => args[0];
  const value = {
    sequence: 1,
    text: "Configuration payload 测试 ".repeat(100_000),
  };
  try {
    for (const compressed of [true, false, true]) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/__backend/ipc`, {
        headers: { cookie: `codex_web_token=${TOKEN}` },
        perMessageDeflate: compressed,
      });
      await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      assert.equal(
        socket.extensions.includes("permessage-deflate"),
        compressed,
      );
      const received = [];
      const bytesBefore = socket._socket.bytesRead;
      const done = new Promise((resolve, reject) => {
        socket.on("message", (raw) => {
          received.push(JSON.parse(raw));
          if (received.length === 2) resolve();
        });
        socket.once("error", reject);
      });
      for (const sequence of [1, 2]) {
        socket.send(
          JSON.stringify({
            type: "ipc-renderer-invoke",
            requestId: `request-${sequence}`,
            channel: "perf-test",
            args: [{ ...value, sequence }],
          }),
        );
      }
      await done;
      assert.deepEqual(
        received.map((message) => message.result.sequence),
        [1, 2],
      );
      assert.equal(received[0].result.text, value.text);
      const wireBytes = socket._socket.bytesRead - bytesBefore;
      if (compressed)
        assert.ok(
          wireBytes < Buffer.byteLength(value.text),
          "large responses must actually compress",
        );
      else assert.ok(wireBytes > Buffer.byteLength(value.text));
      await closeWebSocket(socket);
    }
  } finally {
    bridge.handleRendererInvoke = previous;
    await app.close();
  }
});

test("compressed payloads retain the 64 MiB decompressed limit and cannot crash the server", async () => {
  const app = await startIpcBridgeServer(options(), {
    launchDesktopApp: false,
  });
  const port = app.server.address().port;
  const url = `ws://127.0.0.1:${port}/__backend/ipc`;
  try {
    const socket = await openWebSocket(url, {
      cookie: `codex_web_token=${TOKEN}`,
    });
    assert.ok(socket.extensions.includes("permessage-deflate"));
    const closed = new Promise((resolve) =>
      socket.once("close", (code) => resolve(code)),
    );
    socket.send("x".repeat(64 * 1024 * 1024 + 1));
    assert.equal(await closed, 1009);
    const healthy = await openWebSocket(url, {
      cookie: `codex_web_token=${TOKEN}`,
    });
    await closeWebSocket(healthy);
  } finally {
    await app.close();
  }
});
