import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const AUTH_COOKIE_NAME = "codex_web_token";

const AUTH_COOKIE_MAX_AGE_SECONDS = 31_536_000;
const ENCODED_OCTET = /%[0-9a-f]{2}/i;
const INVALID_PERCENT_ENCODING = /%(?![0-9a-f]{2})/i;
const UNSAFE_PATH_CHARACTER = /[\\\u0000-\u001f\u007f]/;

const UNAUTHORIZED_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>codex-web — authentication required</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
        max-width: 32rem;
        margin: 4rem auto;
        padding: 0 1rem;
        line-height: 1.5;
      }
      code {
        background: rgba(127, 127, 127, 0.15);
        padding: 0.1rem 0.3rem;
        border-radius: 0.25rem;
      }
    </style>
  </head>
  <body>
    <h1>Authentication required</h1>
    <p>
      This codex-web server requires an access token. Open the link you were
      given, or append <code>?token=YOUR_TOKEN</code> to the current URL.
    </p>
  </body>
</html>
`;

export function tokensMatch(
  expectedToken: string,
  providedToken: string | null | undefined,
): boolean {
  if (providedToken == null) {
    return false;
  }

  return timingSafeEqual(
    createHash("sha256").update(expectedToken).digest(),
    createHash("sha256").update(providedToken).digest(),
  );
}

export function getCookieValue(
  cookieHeader: string | undefined,
  cookieName: string,
): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const segment of cookieHeader.split(";")) {
    const separatorIndex = segment.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const name = segment.slice(0, separatorIndex).trim();
    if (name !== cookieName) {
      continue;
    }

    const value = segment.slice(separatorIndex + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

export function buildAuthCookie(token: string, secure: boolean): string {
  const attributes = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`,
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

export function requestIsSecure(
  forwardedProto: string | string[] | undefined,
  socketEncrypted: boolean,
): boolean {
  const rawProto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto;

  if (rawProto) {
    const firstProto = rawProto.split(",")[0]!.trim().toLowerCase();
    if (firstProto === "https") {
      return true;
    }
  }

  return socketEncrypted;
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

export function assertTokenRequirement(
  host: string,
  token: string | null,
): void {
  if (token === null && !isLoopbackHost(host)) {
    throw new Error(
      `refusing to bind to non-loopback host ${host} without an auth token; ` +
        "pass --token or set CODEX_WEB_TOKEN",
    );
  }
}

export function isAuthorizedRequest(
  expectedToken: string,
  cookieHeader: string | undefined,
  queryToken: string | null,
): boolean {
  return (
    tokensMatch(expectedToken, getCookieValue(cookieHeader, AUTH_COOKIE_NAME)) ||
    tokensMatch(expectedToken, queryToken)
  );
}

export function isSafeRequestTarget(rawUrl: string): boolean {
  let pathname = rawUrl.split("?", 1)[0] ?? "";
  if (
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    INVALID_PERCENT_ENCODING.test(pathname) ||
    UNSAFE_PATH_CHARACTER.test(pathname)
  ) {
    return false;
  }

  let pass = 0;
  while (ENCODED_OCTET.test(pathname) && pass < 8) {
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (
      pathname.startsWith("//") ||
      INVALID_PERCENT_ENCODING.test(pathname) ||
      UNSAFE_PATH_CHARACTER.test(pathname)
    ) {
      return false;
    }
    pass += 1;
  }
  if (ENCODED_OCTET.test(pathname)) {
    return false;
  }

  return !pathname
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

function unauthorized(reply: FastifyReply, backend: boolean): FastifyReply {
  reply.header("cache-control", "no-store");
  if (backend) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  return reply.code(401).type("text/html").send(UNAUTHORIZED_HTML);
}

export function installAuthHook(
  app: FastifyInstance,
  expectedToken: string,
): void {
  // Every HTTP route must be registered on this instance after this hook.
  // Raw websocket upgrades are authenticated separately in main.ts.
  app.addHook(
    "onRequest",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rawUrl = request.raw.url ?? request.url;
      if (!isSafeRequestTarget(rawUrl)) {
        reply.header("cache-control", "no-store");
        return reply.code(400).send({ error: "invalid request path" });
      }

      const cookieToken = getCookieValue(
        request.headers.cookie,
        AUTH_COOKIE_NAME,
      );
      if (tokensMatch(expectedToken, cookieToken)) {
        return;
      }

      const url = new URL(request.url, "http://placeholder");
      const queryToken = url.searchParams.get("token");
      if (queryToken !== null && tokensMatch(expectedToken, queryToken)) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return;
        }

        url.searchParams.delete("token");
        const secure = requestIsSecure(
          request.headers["x-forwarded-proto"],
          Boolean((request.raw.socket as { encrypted?: boolean }).encrypted),
        );
        reply.header("cache-control", "no-store");
        reply.header("set-cookie", buildAuthCookie(expectedToken, secure));
        return reply.redirect(url.pathname + url.search, 302);
      }

      return unauthorized(reply, request.url.startsWith("/__backend/"));
    },
  );
}
