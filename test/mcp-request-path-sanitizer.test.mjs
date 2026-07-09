import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { expandTildePath, sanitizeMcpRequestPaths } =
  await importTypescriptModule("src/server/mcp-request-path-sanitizer.ts");

const HOME = "/home/xuni";

function mcpRequest(method, params) {
  return { type: "mcp-request", hostId: "local", request: { id: "1", method, params } };
}

test("expandTildePath expands the home sentinel and home-relative paths", () => {
  assert.equal(expandTildePath("~", HOME), HOME);
  assert.equal(
    expandTildePath("~/code/project", HOME).replaceAll("\\", "/"),
    `${HOME}/code/project`,
  );
  assert.equal(expandTildePath("/absolute/path", HOME), "/absolute/path");
  assert.equal(expandTildePath("relative/path", HOME), "relative/path");
});

test("rewrites the ~ sentinel in runtimeWorkspaceRoots", () => {
  const envelope = mcpRequest("thread/resume", {
    threadId: "t",
    runtimeWorkspaceRoots: ["~", "/srv/project"],
  });
  const result = sanitizeMcpRequestPaths(envelope, HOME);
  assert.ok(result);
  assert.equal(result.method, "thread/resume");
  assert.deepEqual(envelope.request.params.runtimeWorkspaceRoots, [
    HOME,
    "/srv/project",
  ]);
});

test("rewrites writableRoots nested inside a sandbox policy", () => {
  const envelope = mcpRequest("thread/resume", {
    threadId: "t",
    sandbox: {
      type: "workspaceWrite",
      writableRoots: ["~", "~/code"],
      networkAccess: true,
    },
  });
  const result = sanitizeMcpRequestPaths(envelope, HOME);
  assert.ok(result);
  assert.equal(result.changes.length, 2);
  const roots = envelope.request.params.sandbox.writableRoots.map((entry) =>
    entry.replaceAll("\\", "/"),
  );
  assert.deepEqual(roots, [HOME, `${HOME}/code`]);
});

test("drops entries that stay relative after expansion", () => {
  const envelope = mcpRequest("thread/start", {
    runtimeWorkspaceRoots: ["relative/path", "", "/kept"],
  });
  const result = sanitizeMcpRequestPaths(envelope, HOME);
  assert.ok(result);
  assert.deepEqual(envelope.request.params.runtimeWorkspaceRoots, ["/kept"]);
  assert.deepEqual(
    result.changes.map((change) => change.after),
    [null, null],
  );
});

test("expands a tilde cwd but leaves other cwd values alone", () => {
  const envelope = mcpRequest("thread/start", {
    cwd: "~",
    nested: { cwd: "/already/absolute" },
  });
  const result = sanitizeMcpRequestPaths(envelope, HOME);
  assert.ok(result);
  assert.equal(envelope.request.params.cwd, HOME);
  assert.equal(envelope.request.params.nested.cwd, "/already/absolute");
});

test("leaves clean requests untouched and reports null", () => {
  const params = {
    threadId: "t",
    runtimeWorkspaceRoots: ["/srv/project"],
    cwd: "/srv/project",
    sandbox: { type: "workspaceWrite", writableRoots: ["/srv/project"] },
  };
  const envelope = mcpRequest("thread/resume", params);
  assert.equal(sanitizeMcpRequestPaths(envelope, HOME), null);
  assert.deepEqual(envelope.request.params, params);
});

test("ignores non-mcp-request envelopes", () => {
  assert.equal(sanitizeMcpRequestPaths("string arg", HOME), null);
  assert.equal(sanitizeMcpRequestPaths(null, HOME), null);
  assert.equal(
    sanitizeMcpRequestPaths({ type: "other", request: { method: "x" } }, HOME),
    null,
  );
  assert.equal(
    sanitizeMcpRequestPaths(
      { type: "mcp-request", request: { method: "thread/list" } },
      HOME,
    ),
    null,
  );
});

test("does not rewrite strings inside message text content", () => {
  const envelope = mcpRequest("turn/start", {
    threadId: "t",
    items: [{ type: "text", text: "run ls ~ and check writableRoots" }],
  });
  assert.equal(sanitizeMcpRequestPaths(envelope, HOME), null);
  assert.equal(
    envelope.request.params.items[0].text,
    "run ls ~ and check writableRoots",
  );
});
