import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { recoveryNotice } = await importTypescriptModule(
  "src/browser/recovery-notice.ts",
);

// A small DOM harness keeps these tests focused on interaction and state changes.
class Element {
  children = [];
  dataset = {};
  attributes = {};
  style = {};
  disabled = false;
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
  }
  set textContent(value) {
    this.text = value;
    this.children = [];
  }
  get textContent() {
    return (
      (this.text ?? "") +
      this.children.map((child) => child.textContent).join("")
    );
  }
  setAttribute(key, value) {
    this.attributes[key] = value;
  }
  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  prepend(child) {
    child.parent = this;
    this.children.unshift(child);
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (child) => child !== this,
      );
  }
  querySelector(selector) {
    const key = selector
      .slice(6, -1)
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return this.find((element) => Object.hasOwn(element.dataset, key));
  }
  find(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const nested = child.find(predicate);
      if (nested) return nested;
    }
    return null;
  }
}

function dom(t, language = "zh-CN") {
  const document = {
    documentElement: { lang: language },
    createElement: (name) => new Element(name, document),
    getElementById: (id) => document.body.find((element) => element.id === id),
  };
  document.body = document.createElement("body");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    value: document,
    configurable: true,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
  });
  return document;
}

test("reconnect taps enter a visible busy state synchronously and preserve the action element", (t) => {
  const document = dom(t);
  let attempts = 0;
  const retry = () => {
    attempts++;
    button.onclick(); // A second tap while the first attempt starts.
  };
  recoveryNotice("failed", "internal-sensitive-method", retry);
  const notice = document.getElementById("codex-web-recovery");
  const button = notice.querySelector("[data-recovery-retry]");
  assert.equal(button.disabled, false);
  assert.equal(notice.textContent.includes("internal-sensitive-method"), false);
  button.onclick();
  assert.equal(attempts, 1);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "正在重连…");
  recoveryNotice("recovering", "", retry);
  assert.equal(notice.querySelector("[data-recovery-retry]"), button);
  assert.equal(
    notice.querySelector("[data-recovery-message]").attributes["aria-live"],
    "polite",
  );
  recoveryNotice("connected", "", retry);
  assert.equal(document.getElementById("codex-web-recovery"), null);
});

test("offline hints still permit manual retry and diagnostics downloads run within the click", (t) => {
  const document = dom(t, "en-US");
  let clicking = false,
    exports = 0;
  const download = () => {
    assert.equal(clicking, true, "no async boundary before mobile download");
    exports++;
  };
  for (const state of ["waiting-network", "recovering", "failed", "paused"]) {
    recoveryNotice(state, "", () => {}, download);
    const notice = document.getElementById("codex-web-recovery");
    const retry = notice.querySelector("[data-recovery-retry]");
    assert.equal(retry.disabled, state === "recovering" || state === "paused");
    clicking = true;
    notice.querySelector("[data-recovery-export]").onclick();
    clicking = false;
  }
  assert.equal(exports, 4);
  recoveryNotice("failed", "authentication", () => {}, download);
  const notice = document.getElementById("codex-web-recovery");
  assert.equal(notice.querySelector("[data-recovery-retry]"), null);
  assert.ok(notice.querySelector("[data-recovery-export]"));
  assert.match(notice.textContent, /Sign-in expired/);
});

test("failed exports retain an actionable notice and a later retry succeeds", (t) => {
  const document = dom(t);
  let failing = true;
  recoveryNotice(
    "failed",
    "",
    () => {},
    () => {
      if (failing) throw Error("secret diagnostic error");
    },
  );
  const notice = document.getElementById("codex-web-recovery");
  const button = notice.querySelector("[data-recovery-export]");
  button.onclick();
  assert.match(notice.textContent, /未能下载/);
  assert.equal(notice.textContent.includes("secret"), false);
  failing = false;
  assert.doesNotThrow(() => button.onclick());
  assert.equal(button.disabled, false);
});

test("recovery phases expose elapsed time and a usable takeover without duplicate taps", (t) => {
  const document = dom(t);
  let attempts = 0;
  const retry = () => {
    attempts++;
    button.onclick();
  };
  const progress = {
    attempt: 2,
    phase: "session",
    elapsedMs: 9_000,
    remainingMs: 21_000,
    retryAvailable: false,
  };
  recoveryNotice("recovering", "", retry, undefined, progress);
  const notice = document.getElementById("codex-web-recovery");
  const button = notice.querySelector("[data-recovery-retry]");
  assert.ok(notice.textContent.includes("正在恢复会话"));
  assert.ok(notice.textContent.includes("9 / 30 秒"));
  assert.equal(button.disabled, true);
  recoveryNotice("recovering", "", retry, undefined, {
    ...progress,
    phase: "synchronizing",
    elapsedMs: 10_000,
    remainingMs: 20_000,
    retryAvailable: true,
  });
  assert.ok(notice.textContent.includes("正在同步当前会话"));
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "重新尝试");
  button.onclick();
  assert.equal(attempts, 1);
  assert.equal(button.disabled, true);
});
