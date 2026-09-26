import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const {
  AUTH_COOKIE_NAME,
  assertTokenRequirement,
  buildAuthCookie,
  getCookieValue,
  isAuthorizedRequest,
  isLoopbackHost,
  isSafeRequestTarget,
  requestIsSecure,
  tokensMatch,
} = await importTypescriptModule("src/server/auth.ts");

test("token helpers only accept the exact token", () => {
  assert.equal(tokensMatch("secret", "secret"), true);
  assert.equal(tokensMatch("secret", "secreT"), false);
  assert.equal(tokensMatch("secret", null), false);
  assert.equal(
    isAuthorizedRequest("secret", `${AUTH_COOKIE_NAME}=secret`, null),
    true,
  );
  assert.equal(isAuthorizedRequest("secret", undefined, "secret"), true);
  assert.equal(isAuthorizedRequest("secret", undefined, "wrong"), false);
});

test("cookie helpers preserve values and secure browser attributes", () => {
  assert.equal(
    getCookieValue(`other=1; ${AUTH_COOKIE_NAME}=a%20b%3Bc`, AUTH_COOKIE_NAME),
    "a b;c",
  );
  const cookie = buildAuthCookie("a b;c", true);
  assert.match(cookie, new RegExp(`^${AUTH_COOKIE_NAME}=a%20b%3Bc; `));
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=31536000/);
  assert.match(cookie, /; Secure$/);
});

test("forwarded HTTPS and loopback startup rules are recognized", () => {
  assert.equal(requestIsSecure("https, http", false), true);
  assert.equal(requestIsSecure("http", true), true);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("100.90.94.39"), false);
  assertTokenRequirement("127.0.0.1", null);
  assertTokenRequirement("100.90.94.39", "secret");
  assert.throws(
    () => assertTokenRequirement("100.90.94.39", null),
    /without an auth token/,
  );
});

test("unsafe and repeatedly encoded request targets are rejected", () => {
  for (const target of [
    "//example.com/",
    "/../secret",
    "/%2e%2e/secret",
    "/%252e%252e/secret",
    "/%25252e%25252e/secret",
    "/a\\..\\secret",
    "/%5c..%5csecret",
    "/%ZZ",
    "/%2525252525252525252e%2525252525252525252e/secret",
  ]) {
    assert.equal(isSafeRequestTarget(target), false, target);
  }
  assert.equal(isSafeRequestTarget("/assets/app.js?x=1"), true);
  assert.equal(isSafeRequestTarget("/%E4%B8%AD%E6%96%87"), true);
});
