import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import test from "node:test";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
const { parseServerArgs, startIpcBridgeServer } = require(
  "../src/server/main.js"
);

const TOKEN = "integration-secret";

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

function requestRaw(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: requestPath, headers },
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
    socket.once("open", () => reject(new Error("websocket unexpectedly opened")));
    socket.once("error", () => {});
  });
}

function closeWebSocket(socket) {
  return new Promise((resolve) => {
    socket.once("close", resolve);
    socket.close();
  });
}

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
    for (const route of ["/", "/manifest.json", "/assets/preload.js"] ) {
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
