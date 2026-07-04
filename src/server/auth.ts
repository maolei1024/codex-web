import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const AUTH_COOKIE_NAME = "codex_web_token";

const AUTH_COOKIE_MAX_AGE_SECONDS = 31_536_000;

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

export function installAuthHook(
  app: FastifyInstance,
  expectedToken: string,
): void {
  // Auth relies on every route being registered on this instance after this
  // hook is installed; a second Fastify instance or raw http route would
  // bypass it.
  app.addHook(
    "onRequest",
    async (request: FastifyRequest, reply: FastifyReply) => {
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
          Boolean(
            (request.raw.socket as { encrypted?: boolean }).encrypted,
          ),
        );
        reply.header("set-cookie", buildAuthCookie(expectedToken, secure));
        return reply.redirect(url.pathname + url.search, 302);
      }

      if (request.url.startsWith("/__backend/")) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      if (request.method === "GET" || request.method === "HEAD") {
        return reply.code(401).type("text/html").send(UNAUTHORIZED_HTML);
      }

      return reply.code(401).send({ error: "unauthorized" });
    },
  );
}
