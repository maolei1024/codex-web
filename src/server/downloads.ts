import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isSafeRequestTarget } from "./auth";

export function attachmentDisposition(fileName: string): string {
  if (
    !fileName ||
    fileName === "." ||
    fileName === ".." ||
    /[/\\\u0000-\u001f\u007f]/.test(fileName)
  )
    throw new Error("Invalid filename");
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  // ASCII fallback avoids quoted-string escapes; filename* preserves Unicode.
  const fallback = fileName.replace(/[^A-Za-z0-9._ -]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Added after authentication and before /@fs registration; reuse its streaming. */
export function installDownloadHooks(app: FastifyInstance): void {
  const attachments = new WeakMap<FastifyRequest, string>();
  app.addHook("preHandler", async (request, reply) => {
    const rawUrl = request.raw.url ?? request.url;
    if (!rawUrl.startsWith("/@fs/")) return;
    const url = new URL(rawUrl, "http://localhost");
    if (!url.searchParams.has("download")) return;
    reply.header("cache-control", "private, no-store");
    if (
      !isSafeRequestTarget(rawUrl) ||
      url.searchParams.getAll("download").length !== 1 ||
      url.searchParams.get("download") !== "1" ||
      url.searchParams.getAll("filename").length > 1 ||
      (request.method !== "GET" && request.method !== "HEAD")
    ) {
      return reply.code(400).send({ error: "invalid download request" });
    }
    let filePath: string;
    let disposition: string;
    try {
      // /@fs/home/ml/file represents the absolute path /home/ml/file.
      // A second slash after /@fs/ is non-canonical and rejected by static.
      filePath = decodeURIComponent(url.pathname.slice("/@fs".length));
      if (
        !path.isAbsolute(filePath) ||
        filePath.includes("//") ||
        filePath.endsWith("/") ||
        /[\\\u0000-\u001f\u007f]/.test(filePath) ||
        filePath.split("/").some((part) => part === "." || part === "..")
      )
        throw new Error();
      disposition = attachmentDisposition(
        url.searchParams.get("filename") ?? path.basename(filePath),
      );
    } catch {
      return reply
        .code(400)
        .send({ error: "invalid download path or filename" });
    }
    try {
      if (!(await stat(filePath)).isFile())
        return reply.code(404).send({ error: "not a regular file" });
      await access(filePath, constants.R_OK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const status =
        code === "EACCES" || code === "EPERM"
          ? 403
          : code === "ENOENT" || code === "ENOTDIR"
            ? 404
            : 500;
      return reply.code(status).send({ error: "download file unavailable" });
    }
    attachments.set(request, disposition);
    // Pass the validated, decoded filesystem path to the existing streaming
    // sender. Its wildcard URL handler keeps reserved %23/%3F/%26 escaped,
    // which would otherwise select the wrong file for names containing #?&.
    return reply.sendFile(filePath, "/");
  });
  app.addHook("onSend", async (request, reply) => {
    const disposition = attachments.get(request);
    if (!disposition) return;
    reply.header("cache-control", "private, no-store");
    reply.header("x-content-type-options", "nosniff");
    if (
      reply.statusCode === 200 ||
      reply.statusCode === 206 ||
      reply.statusCode === 304
    ) {
      reply.header("content-disposition", disposition);
    }
  });
}
