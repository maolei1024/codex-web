import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile, rm, open } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const {
  startIpcBridgeServer,
  parseServerArgs,
} = require("../src/server/main.js");
const { attachmentDisposition } = require("../src/server/downloads.js");
const cookie = "codex_web_token=download-test-token";

function raw(port, requestPath, method = "GET", headers = { cookie }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: requestPath, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}
function url(file, query = "download=1") {
  return `/@fs${file.split("/").map(encodeURIComponent).join("/")}?${query}`;
}
async function fixture(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codex-download-test-"),
  );
  const app = await startIpcBridgeServer(
    {
      ...parseServerArgs([], {
        CODEX_WEB_TOKEN: "download-test-token",
        CODEX_WEB_UPLOAD_ROOT: directory,
      }),
      port: 0,
    },
    { launchDesktopApp: false },
  );
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, port: app.server.address().port };
}

test("download headers preserve UTF-8 filenames without header injection", () => {
  const name = '中文 "报告" & #?\'().docx';
  const value = attachmentDisposition(name);
  assert.match(
    value,
    /^attachment; filename="[A-Za-z0-9._ -]+"; filename\*=UTF-8''/,
  );
  assert.equal(decodeURIComponent(value.split("UTF-8''")[1]), name);
  for (const name of ["", ".", "..", "../file", "a\\b", "a\r\nX-Evil: 1"])
    assert.throws(() => attachmentDisposition(name));
});

test("GET HEAD and ranges support attachments while ordinary previews stay unchanged", async (t) => {
  const { directory, port } = await fixture(t);
  for (const extension of ["docx", "pdf", "png", "zip"]) {
    const file = path.join(directory, `中文 & #? ' (1).${extension}`);
    const content = Buffer.from("PK\u0003\u0004download-bytes");
    await writeFile(file, content);
    const response = await raw(port, url(file));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, content);
    await writeFile(
      `${file}.gz`,
      gzipSync(Buffer.from("not the requested file")),
    );
    const encoded = await raw(port, url(file), "GET", {
      cookie,
      "accept-encoding": "gzip, br",
    });
    assert.equal(encoded.status, 200);
    assert.deepEqual(encoded.body, content);
    assert.equal(encoded.headers["content-encoding"], undefined);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(
      decodeURIComponent(
        response.headers["content-disposition"].split("UTF-8''")[1],
      ),
      path.basename(file),
    );
    const head = await raw(port, url(file), "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(+head.headers["content-length"], content.length);
    const range = await raw(port, url(file), "GET", {
      cookie,
      range: "bytes=0-3",
    });
    assert.equal(range.status, 206);
    assert.deepEqual(range.body, content.subarray(0, 4));
    assert.match(range.headers["content-disposition"], /^attachment;/);
    const previewFile = path.join(directory, `preview-中文.${extension}`);
    await writeFile(previewFile, content);
    const preview = await raw(port, url(previewFile, ""));
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body, content);
    assert.equal(preview.headers["content-disposition"], undefined);
  }
});

test("unauthenticated or invalid cookies cannot GET HEAD or Range-download files", async (t) => {
  const { directory, port } = await fixture(t);
  const file = path.join(directory, "private.txt");
  await writeFile(file, "private");
  for (const headers of [{}, { cookie: "codex_web_token=incorrect" }]) {
    for (const method of ["GET", "HEAD"])
      assert.equal((await raw(port, url(file), method, headers)).status, 401);
    assert.equal(
      (await raw(port, url(file), "GET", { ...headers, range: "bytes=0-1" }))
        .status,
      401,
    );
  }
});

test("missing files directories and unreadable files fail safely before attachment headers", async (t) => {
  const { directory, port } = await fixture(t);
  for (const file of [directory, path.join(directory, "missing")]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await raw(port, url(file), method);
      assert.equal(response.status, 404);
      assert.equal(response.headers["content-disposition"], undefined);
    }
  }
  if (process.getuid?.() !== 0) {
    const file = path.join(directory, "unreadable");
    await writeFile(file, "private");
    await chmod(file, 0);
    try {
      for (const method of ["GET", "HEAD"])
        assert.equal((await raw(port, url(file), method)).status, 403);
    } finally {
      await chmod(file, 0o600);
    }
  }
});

test("invalid download paths and filename query injection are rejected", async (t) => {
  const { directory, port } = await fixture(t);
  const file = path.join(directory, "file");
  await writeFile(file, "ok");
  for (const requestPath of [
    "/@fs//tmp/file?download=1",
    "/@fs//tmp/../file?download=1",
    "/@fs//tmp/%2e%2e/file?download=1",
    "/@fs//tmp/%252e%252e/file?download=1",
    "/@fs//tmp/%00file?download=1",
    "/@fs//tmp/%5cfile?download=1",
    url(file, "download=1&filename=a%0d%0aX-Evil%3Atrue"),
    url(file, "download=1&filename=..%2Fa"),
    url(file, "download=1&filename="),
    url(file, "download=1&filename=a&filename=b"),
    url(file, "download=1&download=1"),
  ]) {
    assert.equal((await raw(port, requestPath)).status, 400, requestPath);
  }
  const response = await raw(
    port,
    url(file, `download=1&filename=${encodeURIComponent('改名 "文件".pdf')}`),
  );
  assert.equal(response.status, 200);
  assert.equal(
    decodeURIComponent(
      response.headers["content-disposition"].split("UTF-8''")[1],
    ),
    '改名 "文件".pdf',
  );
});

test("large files stream with correct length hash and range support", async (t) => {
  const { directory, port } = await fixture(t);
  const file = path.join(directory, "large.zip");
  const fileHandle = await open(file, "w");
  const size = 32 * 1024 * 1024;
  await fileHandle.truncate(size);
  await fileHandle.close();
  const expected = createHash("sha256");
  for (let i = 0; i < 32; i++) expected.update(Buffer.alloc(1024 * 1024));
  await new Promise((resolve, reject) => {
    http
      .get(
        { hostname: "127.0.0.1", port, path: url(file), headers: { cookie } },
        (res) => {
          assert.equal(res.statusCode, 200);
          assert.equal(+res.headers["content-length"], size);
          const digest = createHash("sha256");
          let bytes = 0;
          res.on("data", (chunk) => {
            bytes += chunk.length;
            digest.update(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              assert.equal(bytes, size);
              assert.equal(digest.digest("hex"), expected.digest("hex"));
              resolve();
            } catch (e) {
              reject(e);
            }
          });
        },
      )
      .on("error", reject);
  });
  assert.equal(
    (
      await raw(port, url(file), "GET", {
        cookie,
        range: `bytes=${size - 4}-${size - 1}`,
      })
    ).status,
    206,
  );
});
