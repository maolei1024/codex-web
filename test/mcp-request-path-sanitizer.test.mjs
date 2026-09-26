import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { expandTildePath, sanitizeMcpRequestPaths } =
  await importTypescriptModule("src/server/mcp-request-path-sanitizer.ts");
const HOME = "/home/ml";

function requestEnvelope(method, params) {
  return { type: "mcp-request", request: { id: "1", method, params } };
}

test("tilde paths expand and invalid absolute path arrays are filtered", () => {
  assert.equal(expandTildePath("~/code", HOME), `${HOME}/code`);
  const envelope = requestEnvelope("thread/resume", {
    cwd: "~",
    runtimeWorkspaceRoots: ["relative", "~", "/srv/project"],
    sandbox: { writableRoots: ["bad", "~/code"] },
  });
  const result = sanitizeMcpRequestPaths(envelope, HOME);
  assert.ok(result);
  assert.equal(envelope.request.params.cwd, HOME);
  assert.deepEqual(envelope.request.params.runtimeWorkspaceRoots, [
    HOME,
    "/srv/project",
  ]);
  assert.deepEqual(envelope.request.params.sandbox.writableRoots, [
    `${HOME}/code`,
  ]);
});

test("an entirely invalid runtimeWorkspaceRoots override is removed", () => {
  const envelope = requestEnvelope("thread/start", {
    runtimeWorkspaceRoots: ["998a37a9-8db3-4060-9fcb-f9ecb9856a11"],
  });
  assert.ok(sanitizeMcpRequestPaths(envelope, HOME));
  assert.equal("runtimeWorkspaceRoots" in envelope.request.params, false);
});

test("nested message-port payloads are sanitized without touching text", () => {
  const envelope = requestEnvelope("turn/start", {
    cwd: "~/project",
    items: [{ type: "text", text: "run ls ~ and inspect writableRoots" }],
  });
  const frame = { rpc: { payload: [envelope] } };
  assert.ok(sanitizeMcpRequestPaths(frame, HOME));
  assert.equal(envelope.request.params.cwd, `${HOME}/project`);
  assert.equal(
    envelope.request.params.items[0].text,
    "run ls ~ and inspect writableRoots",
  );
});

test("clean or non-request payloads are unchanged", () => {
  assert.equal(sanitizeMcpRequestPaths({ type: "other" }, HOME), null);
  assert.equal(
    sanitizeMcpRequestPaths(
      requestEnvelope("thread/list", { cwd: "/srv/project" }),
      HOME,
    ),
    null,
  );
});
