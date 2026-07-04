import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const authModule = await importTypescriptModule("src/server/auth.ts");
const {
  AUTH_COOKIE_NAME,
  assertTokenRequirement,
  buildAuthCookie,
  getCookieValue,
  isAuthorizedRequest,
  isLoopbackHost,
  requestIsSecure,
  tokensMatch,
} = authModule;

test("tokensMatch only accepts the exact expected token", () => {
  assert.equal(tokensMatch("secret", "secret"), true);
  assert.equal(tokensMatch("secret", "secreT"), false);
  assert.equal(tokensMatch("secret", "secret-but-longer"), false);
  assert.equal(tokensMatch("secret", "sec"), false);
  assert.equal(tokensMatch("secret", null), false);
  assert.equal(tokensMatch("secret", undefined), false);
  assert.equal(tokensMatch("secret", ""), false);
});

test("getCookieValue finds the named cookie in a cookie header", () => {
  assert.equal(getCookieValue(undefined, AUTH_COOKIE_NAME), null);
  assert.equal(getCookieValue("", AUTH_COOKIE_NAME), null);
  assert.equal(
    getCookieValue(`${AUTH_COOKIE_NAME}=abc`, AUTH_COOKIE_NAME),
    "abc",
  );
  assert.equal(
    getCookieValue(
      `other=1;  ${AUTH_COOKIE_NAME}=abc ; another=2`,
      AUTH_COOKIE_NAME,
    ),
    "abc",
  );
  assert.equal(
    getCookieValue(`${AUTH_COOKIE_NAME}=a=b=c`, AUTH_COOKIE_NAME),
    "a=b=c",
  );
  assert.equal(
    getCookieValue(`${AUTH_COOKIE_NAME}=a%20b%3B`, AUTH_COOKIE_NAME),
    "a b;",
  );
  assert.equal(
    getCookieValue(`x${AUTH_COOKIE_NAME}=abc`, AUTH_COOKIE_NAME),
    null,
  );
  assert.equal(
    getCookieValue(`garbage; ${AUTH_COOKIE_NAME}=abc`, AUTH_COOKIE_NAME),
    "abc",
  );
  assert.equal(
    getCookieValue(`${AUTH_COOKIE_NAME}=%E0%A4%A`, AUTH_COOKIE_NAME),
    "%E0%A4%A",
  );
});

test("buildAuthCookie sets browser attributes", () => {
  const insecure = buildAuthCookie("secret", false);
  assert.match(insecure, new RegExp(`^${AUTH_COOKIE_NAME}=secret; `));
  assert.match(insecure, /HttpOnly/);
  assert.match(insecure, /SameSite=Lax/);
  assert.match(insecure, /Path=\//);
  assert.match(insecure, /Max-Age=31536000/);
  assert.doesNotMatch(insecure, /Secure/);

  const secure = buildAuthCookie("secret", true);
  assert.match(secure, /; Secure$/);

  const encoded = buildAuthCookie("a b;c", false);
  assert.match(encoded, new RegExp(`^${AUTH_COOKIE_NAME}=a%20b%3Bc; `));
});

test("requestIsSecure prefers x-forwarded-proto over the socket", () => {
  assert.equal(requestIsSecure("https", false), true);
  assert.equal(requestIsSecure("http", false), false);
  assert.equal(requestIsSecure("https, http", false), true);
  assert.equal(requestIsSecure("HTTPS", false), true);
  assert.equal(requestIsSecure(["https", "http"], false), true);
  assert.equal(requestIsSecure(undefined, true), true);
  assert.equal(requestIsSecure(undefined, false), false);
  assert.equal(requestIsSecure("http", true), true);
});

test("isLoopbackHost only matches loopback addresses", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.5.5.5"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("::"), false);
  assert.equal(isLoopbackHost("192.168.1.10"), false);
  assert.equal(isLoopbackHost("example.com"), false);
});

test("assertTokenRequirement requires a token for non-loopback hosts", () => {
  assertTokenRequirement("127.0.0.1", null);
  assertTokenRequirement("0.0.0.0", "secret");
  assert.throws(() => assertTokenRequirement("0.0.0.0", null), /--token/);
});

test("isAuthorizedRequest accepts a cookie or query token", () => {
  assert.equal(
    isAuthorizedRequest("secret", `${AUTH_COOKIE_NAME}=secret`, null),
    true,
  );
  assert.equal(isAuthorizedRequest("secret", undefined, "secret"), true);
  assert.equal(
    isAuthorizedRequest("secret", `${AUTH_COOKIE_NAME}=wrong`, "secret"),
    true,
  );
  assert.equal(
    isAuthorizedRequest("secret", `${AUTH_COOKIE_NAME}=wrong`, "wrong"),
    false,
  );
  assert.equal(isAuthorizedRequest("secret", undefined, null), false);
});
