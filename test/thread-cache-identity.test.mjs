import assert from "node:assert/strict";
import test from "node:test";
import * as crypto from "node:crypto";
import { readFile } from "node:fs/promises";
const source = await readFile(
  "scratch/asar/.vite/build/main-CwxgTOle.js",
  "utf8",
);
const start = source.indexOf("function webHistoryIdentity("),
  end = source.indexOf("function BJe(", start);
assert.ok(
  start >= 0 && end > start,
  "pinned authenticated read-state identity extension must be packaged",
);
const identity = (salt) =>
  new Function(
    "R",
    "process",
    `${source.slice(start, end)};return webHistoryIdentity;`,
  )(crypto, { env: { CODEX_WEB_TOKEN: salt } });
test("cache identity is opaque, stable across refreshes and separated by account and site login", () => {
  const hash = identity("site-token"),
    api = { kind: "execution-storage", authMode: "apikey" };
  const first = hash(api, { authToken: "fixture-key-one" });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(hash(api, { authToken: "fixture-key-one" }), first);
  assert.notEqual(hash(api, { authToken: "fixture-key-two" }), first);
  assert.notEqual(
    identity("other-site-token")(api, { authToken: "fixture-key-one" }),
    first,
  );
  const account = { kind: "chatgpt", accountId: "account", userId: "user" };
  assert.equal(
    hash(account, { authToken: "rotating-token-one" }),
    hash(account, { authToken: "rotating-token-two" }),
  );
  assert.notEqual(
    hash(account, {}),
    hash({ ...account, userId: "other-user" }, {}),
  );
  assert.equal(hash(api, {}), null);
  assert.equal(identity("")(account, {}), null);
  assert.equal(hash(null, {}), null);
});
