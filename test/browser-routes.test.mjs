import test from "node:test";
import assert from "node:assert/strict";
import { importTypescriptModule } from "./import-typescript-module.mjs";
let popstate;
const events = [];
globalThis.window = {
  addEventListener(name, callback) {
    if (name === "popstate") popstate = callback;
  },
  dispatchEvent(event) {
    events.push(event);
  },
  location: {},
};
const routes = await importTypescriptModule("src/browser/routes.ts");

test("remote thread navigation and refresh preserve native host routing without retaining credentials", () => {
  const query =
    "?hostId=remote-ssh-discovered%3Atest&token=private&prompt=private";
  const route = routes.mapMemoryPathToBrowserPath("/local/thread-1", query);
  assert.equal(
    route.path,
    "/thread/thread-1?hostId=remote-ssh-discovered%3Atest",
  );
  const url = new URL(route.path, "https://example.test");
  assert.equal(
    routes.mapBrowserPathToInitialRoute(url.pathname, url.search).memoryPath,
    "/local/thread-1?hostId=remote-ssh-discovered%3Atest",
  );
  assert.equal(
    routes.mapMemoryPathToBrowserPath("/local/thread-1").path,
    "/thread/thread-1",
  );
});

test("browser history restores the remote host rather than silently selecting local", () => {
  window.location = {
    pathname: "/thread/thread-2",
    search: "?hostId=remote-other",
  };
  popstate();
  assert.equal(events.at(-1).data.path, "/local/thread-2?hostId=remote-other");
  window.location = { pathname: "/thread/thread-3", search: "" };
  popstate();
  assert.equal(events.at(-1).data.path, "/local/thread-3");
});

test("old bookmarks are upgraded from unique native catalog ownership, without guessing or leaking query parameters", async () => {
  const hosts = ["local", "remote-test"];
  const read = async (keys) => {
    assert.deepEqual(
      keys,
      hosts.map((hostId) => ({ hostId, threadId: "thread-1" })),
    );
    return [
      { hostId: "remote-test", threadId: "thread-1", sourceKind: "local" },
    ];
  };
  assert.deepEqual(
    await routes.resolveLegacyThreadRoute(
      "/thread/thread-1",
      "?token=private",
      hosts,
      read,
    ),
    {
      memoryPath: "/local/thread-1?hostId=remote-test",
      browserPath: "/thread/thread-1?hostId=remote-test",
    },
  );
  const noRead = async () => {
    throw Error("must not read");
  };
  assert.equal(
    await routes.resolveLegacyThreadRoute(
      "/thread/thread-1",
      "?hostId=local",
      hosts,
      noRead,
    ),
    null,
  );
  assert.equal(
    await routes.resolveLegacyThreadRoute("/", "", hosts, noRead),
    null,
  );
  for (const entries of [
    [],
    hosts.map((hostId) => ({
      hostId,
      threadId: "thread-1",
      sourceKind: "local",
    })),
    [{ hostId: "unknown", threadId: "thread-1", sourceKind: "local" }],
  ]) {
    assert.equal(
      await routes.resolveLegacyThreadRoute(
        "/thread/thread-1",
        "",
        hosts,
        async () => entries,
      ),
      null,
    );
  }
});
