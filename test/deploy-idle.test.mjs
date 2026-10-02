import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { readActivity } = createRequire(import.meta.url)(
  "../.ci/wait-for-idle.cjs",
);

test("deployment waits for active threads without fetching conversation content", async () => {
  let busy = true;
  const request = async (method, params) => {
    if (method === "thread/loaded/list")
      return { data: ["existing", "ephemeral"] };
    assert.equal(params.includeTurns, false);
    return {
      thread: {
        status: {
          type: busy && params.threadId === "existing" ? "active" : "idle",
        },
      },
    };
  };
  assert.deepEqual(await readActivity(request), { loaded: 2, active: 1 });
  busy = false;
  assert.deepEqual(await readActivity(request), { loaded: 2, active: 0 });
});

test("missing activity or an unavailable backend blocks deployment", async () => {
  await assert.rejects(
    readActivity(async () => {
      throw new Error("disconnected");
    }),
    /disconnected/,
  );
  await assert.rejects(
    readActivity(async (method) =>
      method === "thread/loaded/list" ? { data: ["unknown"] } : { thread: {} },
    ),
    /Cannot establish/,
  );
});
