import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  BrowserWindow,
  Notification,
} = require("../src/server/electron/index.js");

test("only the first live BrowserWindow broadcasts renderer events", () => {
  BrowserWindow.allWindows = [];
  BrowserWindow.focusedWindow = null;
  BrowserWindow.nextId = 1;
  const broadcasts = [];
  globalThis.__codexElectronIpcBridge = {
    broadcastToRenderer(message) {
      broadcasts.push(message);
    },
  };

  const primary = new BrowserWindow();
  const secondary = new BrowserWindow();
  primary.webContents.send("codex_desktop:message-for-view", { id: 1 });
  secondary.webContents.send("codex_desktop:message-for-view", { id: 1 });
  assert.equal(broadcasts.length, 1);

  primary.destroy();
  secondary.webContents.send("codex_desktop:message-for-view", { id: 2 });
  assert.equal(broadcasts.length, 2);
});

test("native worktree failure notifications do not crash the Web host", async () => {
  const source = await readFile(
    "scratch/asar/.vite/build/main-CwxgTOle.js",
    "utf8",
  );
  const managerStart = source.indexOf("var Qg = class {");
  const managerEnd = source.indexOf("\n  $g = class {", managerStart);
  const failureStart = source.indexOf("    notifyFailure(e, t) {");
  const failureEnd = source.indexOf("\n    publish() {", failureStart);
  assert.ok(managerStart >= 0 && managerEnd > managerStart);
  assert.ok(failureStart >= 0 && failureEnd > failureStart);

  // Exercise the pinned Desktop caller with the real Electron adapter; do not
  // inject isSupported, which would hide the missing API that crashed the host.
  const warnings = [];
  const NativeNotificationManager = new Function(
    "_",
    "qg",
    `${source.slice(managerStart, managerEnd).replace(/,\s*$/, ";")}
     return Qg;`,
  )({ Notification }, () => ({ warning: (message) => warnings.push(message) }));
  const NativeWorktreeFailure = new Function(
    "r",
    `return class { ${source.slice(failureStart, failureEnd)} };`,
  )({ B: { turnMode: { key: "turn-mode" } } });
  const manager = new NativeNotificationManager({ platform: "linux" });
  const worktree = new NativeWorktreeFailure();
  worktree.options = {
    settingsStore: { getEffective: () => "always" },
    windowManager: { getPrimaryWindow: () => ({ webContents: {} }) },
    desktopNotificationManager: manager,
  };

  assert.doesNotThrow(() =>
    worktree.notifyFailure("worktree-test", "Setup failed"),
  );
  assert.deepEqual(warnings, ["Notification API not supported on this host"]);
  assert.equal(manager.notifications.size, 0);
});
