import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { app } = require("../src/server/electron/index.js");

test("persistent Electron state can be separated from installed application files", () => {
  const previous = process.env.CODEX_WEB_DATA_DIR;
  process.env.CODEX_WEB_DATA_DIR = "/data/app";
  try {
    for (const name of ["userData", "sessionData", "cache", "logs", "temp"]) {
      assert.equal(app.getPath(name), `/data/app/${name}`);
    }
    assert.equal(app.getAppPath(), process.cwd());
    assert.equal(app.getPath("home"), homedir());
  } finally {
    if (previous === undefined) delete process.env.CODEX_WEB_DATA_DIR;
    else process.env.CODEX_WEB_DATA_DIR = previous;
  }
});

test("ChatGPT projects default to the user's home instead of the source or release directory", () => {
  const previous = process.env.CODEX_WEB_DOCUMENTS_DIR;
  delete process.env.CODEX_WEB_DOCUMENTS_DIR;
  try {
    assert.equal(app.getPath("home"), homedir());
    assert.equal(
      path.join(app.getPath("documents"), "ChatGPT"),
      path.join(homedir(), "ChatGPT"),
    );
    assert.equal(app.getPath("userData"), process.cwd());
  } finally {
    if (previous === undefined) delete process.env.CODEX_WEB_DOCUMENTS_DIR;
    else process.env.CODEX_WEB_DOCUMENTS_DIR = previous;
  }
});

test("an explicit documents parent controls the ChatGPT project location", () => {
  const previous = process.env.CODEX_WEB_DOCUMENTS_DIR;
  process.env.CODEX_WEB_DOCUMENTS_DIR = path.join(homedir(), "Documents");
  try {
    assert.equal(
      path.join(app.getPath("documents"), "ChatGPT"),
      path.join(homedir(), "Documents", "ChatGPT"),
    );
    assert.equal(app.getPath("userData"), process.cwd());
  } finally {
    if (previous === undefined) delete process.env.CODEX_WEB_DOCUMENTS_DIR;
    else process.env.CODEX_WEB_DOCUMENTS_DIR = previous;
  }
});
