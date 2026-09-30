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
