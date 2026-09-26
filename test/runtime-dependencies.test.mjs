import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

test("native runtime dependencies load under the deployment Node runtime", async () => {
  const Database = require("better-sqlite3");
  const database = new Database(":memory:");
  try {
    assert.equal(database.prepare("select 1 as value").get().value, 1);
  } finally {
    database.close();
  }

  const watcher = await import("@parcel/watcher");
  assert.equal(typeof watcher.subscribe, "function");
});
