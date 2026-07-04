#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs as parseCliArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { installModuleAliasHook } from "./module";
import { glob } from "glob";
import {
  assertTokenRequirement,
  installAuthHook,
  isAuthorizedRequest,
} from "./auth";

type ServerOptions = {
  host: string;
  port: number;
  token: string | null;
  maxUploadBytes: number;
};

const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// Native pings sweep half-open sockets server-side; the app-level ping gives
// the browser (which cannot observe native pings) traffic to detect staleness
// against, and keeps reverse-proxy idle timeouts from firing.
const SOCKET_PING_INTERVAL_MS = 30_000;
const APP_PING_INTERVAL_MS = 20_000;
const MAX_MISSED_PONGS = 2;

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
      sourceUrl: string;
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
      sourceUrl: string;
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
    }
  | {
      type: "app-host-port-connect";
      portId: string;
      channel: string;
    }
  | {
      type: "app-host-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "app-host-port-close";
      portId: string;
    };

type MainToRendererMessage =
  | {
      type: "ping";
    }
  | {
      type: "app-host-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "app-host-port-close";
      portId: string;
    }
  | {
      type: "ipc-main-event";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: true;
      result: WorkspaceDirectoryEntries;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    };

type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
};

type WorkspaceDirectoryEntries = {
  directoryPath: string;
  parentPath: string | null;
  entries: WorkspaceDirectoryEntry[];
};

function workspaceDirectoryEntryTypeRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.type === "directory" ? 0 : 1;
}

function workspaceDirectoryEntryHiddenRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.name.startsWith(".") ? 1 : 0;
}

function compareWorkspaceDirectoryEntries(
  left: WorkspaceDirectoryEntry,
  right: WorkspaceDirectoryEntry,
): number {
  return (
    workspaceDirectoryEntryTypeRank(left) -
      workspaceDirectoryEntryTypeRank(right) ||
    workspaceDirectoryEntryHiddenRank(left) -
      workspaceDirectoryEntryHiddenRank(right) ||
    left.name.localeCompare(right.name)
  );
}

type IpcMainBridgeState = {
  broadcastToRenderer?: (message: MainToRendererMessage) => void;
  handleRendererInvoke?: (channel: string, args: unknown[]) => Promise<unknown>;
  handleRendererSend?: (channel: string, args: unknown[]) => void;
  handleRendererPortConnect?: (portId: string, channel: string) => void;
  handleRendererPortMessage?: (portId: string, data: unknown) => void;
  handleRendererPortClose?: (portId: string) => void;
};

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  server [--host <host>] [--port <port>] [--token <token>] [--max-upload-bytes <n>]",
      "",
      "Defaults:",
      "  --host 127.0.0.1",
      "  --port 8214",
      "  --token unset (or CODEX_WEB_TOKEN); required for non-loopback hosts",
      "  --max-upload-bytes 104857600 (or CODEX_WEB_MAX_UPLOAD_BYTES)",
      "",
      "Examples:",
      "  yarn server",
      "  yarn server --port 9000",
      "  yarn server --host 0.0.0.0 --token my-secret-token",
    ].join("\n"),
  );
}

function parsePort(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return parsed;
}

function parseMaxUploadBytes(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid max upload bytes: ${raw}`);
  }
  return parsed;
}

function parseServerArgs(
  args: string[],
  env: NodeJS.ProcessEnv,
): ServerOptions {
  const parsed = parseCliArgs({
    args,
    allowPositionals: false,
    options: {
      help: {
        short: "h",
        type: "boolean",
      },
      host: {
        type: "string",
      },
      port: {
        type: "string",
      },
      token: {
        type: "string",
      },
      "max-upload-bytes": {
        type: "string",
      },
    },
    strict: true,
  });

  if (parsed.values.help) {
    printUsage();
    process.exit(0);
  }

  const token = parsed.values.token ?? env.CODEX_WEB_TOKEN ?? null;
  if (token !== null && token.length === 0) {
    throw new Error("auth token must not be empty");
  }

  const rawMaxUploadBytes =
    parsed.values["max-upload-bytes"] ?? env.CODEX_WEB_MAX_UPLOAD_BYTES;

  return {
    host: parsed.values.host ?? "127.0.0.1",
    port: parsed.values.port ? parsePort(parsed.values.port) : 8214,
    token,
    maxUploadBytes: rawMaxUploadBytes
      ? parseMaxUploadBytes(rawMaxUploadBytes)
      : DEFAULT_MAX_UPLOAD_BYTES,
  };
}

function getIpcMainBridgeState(): IpcMainBridgeState {
  const globals = globalThis as typeof globalThis & {
    __codexElectronIpcBridge?: IpcMainBridgeState;
  };
  if (!globals.__codexElectronIpcBridge) {
    globals.__codexElectronIpcBridge = {};
  }
  return globals.__codexElectronIpcBridge;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

async function getWorkspaceDirectoryEntries({
  directoryPath,
  directoriesOnly,
}: {
  directoryPath: string | null;
  directoriesOnly: boolean;
}): Promise<WorkspaceDirectoryEntries> {
  const requestedPath = directoryPath?.trim() || os.homedir();
  const resolvedPath = path.resolve(requestedPath);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`Directory not found: ${requestedPath}`);
  }

  const entries = (await fs.readdir(resolvedPath, { withFileTypes: true }))
    .flatMap((entry): WorkspaceDirectoryEntry[] => {
      const type = entry.isDirectory() ? "directory" : "file";
      if (directoriesOnly && type !== "directory") {
        return [];
      }

      return [
        {
          name: entry.name,
          path: path.join(resolvedPath, entry.name),
          type,
        },
      ];
    })
    .sort(compareWorkspaceDirectoryEntries);

  const rootPath = path.parse(resolvedPath).root;
  const parentPath =
    resolvedPath === rootPath ? null : path.dirname(resolvedPath);

  return {
    directoryPath: resolvedPath,
    parentPath,
    entries,
  };
}

function ensureElectronLikeProcessContext(): void {
  const versions = process.versions as NodeJS.ProcessVersions & {
    electron?: string;
  };
  if (!versions.electron) {
    Object.defineProperty(versions, "electron", {
      value: "41.2.0",
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  const processWithElectronFields = process as NodeJS.Process & {
    resourcesPath?: string;
    type?: string;
  };
  processWithElectronFields.resourcesPath ??= path.resolve(
    __dirname,
    "../../scratch/asar",
  );
  processWithElectronFields.type ??= "browser";
}

async function startIpcBridgeServer(options: ServerOptions): Promise<void> {
  const bridgeState = getIpcMainBridgeState();
  const app = Fastify({ logger: false });
  const websocketServer = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  const missedPings = new Map<WebSocket, number>();

  if (options.token !== null) {
    installAuthHook(app, options.token);
  }

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: options.maxUploadBytes,
    },
  });

  const uploadRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-web-uploads-"),
  );

  app.post("/__backend/upload", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "expected multipart upload body" });
    }

    const files = await Array.fromAsync(
      (async function* () {
        for await (const part of request.files()) {
          const label = part.filename?.trim() || "upload";

          const uploadedPath = path.join(uploadRoot, randomUUID());

          await fs.writeFile(uploadedPath, await part.toBuffer());

          yield {
            label,
            path: uploadedPath,
            fsPath: uploadedPath,
          };
        }
      })(),
    );

    return reply.send({ files });
  });

  await app.register(fastifyStatic, {
    root: "/",
    prefix: "/@fs/",
    decorateReply: false,
  });

  const webviewRoot = path.resolve(__dirname, "../../scratch/asar/webview");

  // Bundles under assets/ are content-hashed, so they can be cached forever —
  // except preload.js(.map), which keeps a stable name across releases and
  // must be revalidated or stale clients keep a shim that no longer matches
  // the deployed webview. preCompressed serves the .br/.gz siblings generated
  // by scripts/precompress.mjs and falls back to the plain file when absent.
  await app.register(fastifyStatic, {
    root: path.join(webviewRoot, "assets"),
    prefix: "/assets/",
    decorateReply: false,
    preCompressed: true,
    maxAge: "1y",
    immutable: true,
  });

  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/assets/preload.js")) {
      reply.header("cache-control", "no-cache");
    }
  });

  await app.register(fastifyStatic, {
    root: webviewRoot,
    prefix: "/",
    preCompressed: true,
  });

  app.get("/", async (_request, reply) => {
    return reply.sendFile("index.html");
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/@fs/")) {
      return reply.code(404).send({ error: "Not Found" });
    }

    if (request.method === "GET") {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not Found" });
  });

  app.server.on("upgrade", (request, socket, head) => {
    const requestUrl = request.url ?? "/";
    const host = request.headers.host ?? "localhost";
    const url = new URL(requestUrl, `http://${host}`);
    if (url.pathname !== "/__backend/ipc") {
      socket.destroy();
      return;
    }

    if (
      options.token !== null &&
      !isAuthorizedRequest(
        options.token,
        request.headers.cookie,
        url.searchParams.get("token"),
      )
    ) {
      const body = JSON.stringify({ error: "unauthorized" });
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\n" +
          "Content-Type: application/json\r\n" +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          "Connection: close\r\n" +
          "\r\n" +
          body,
      );
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      websocketServer.emit("connection", upgradedSocket, request);
    });
  });

  bridgeState.broadcastToRenderer = (message: MainToRendererMessage): void => {
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  };

  websocketServer.on("connection", (socket) => {
    sockets.add(socket);
    missedPings.set(socket, 0);

    socket.on("pong", () => {
      missedPings.set(socket, 0);
    });

    socket.on("close", () => {
      sockets.delete(socket);
      missedPings.delete(socket);
    });

    socket.on("message", (rawData) => {
      let message: RendererToMainMessage;
      try {
        message = JSON.parse(String(rawData)) as RendererToMainMessage;
      } catch (error) {
        console.error("[ipc-bridge] invalid JSON payload", error);
        return;
      }

      if (message.type === "ipc-renderer-send") {
        bridgeState.handleRendererSend?.(message.channel, message.args);
        return;
      }

      if (message.type === "app-host-port-connect") {
        bridgeState.handleRendererPortConnect?.(message.portId, message.channel);
        return;
      }

      if (message.type === "app-host-port-message") {
        bridgeState.handleRendererPortMessage?.(message.portId, message.data);
        return;
      }

      if (message.type === "app-host-port-close") {
        bridgeState.handleRendererPortClose?.(message.portId);
        return;
      }

      if (message.type === "workspace-directory-entries-request") {
        const { requestId } = message;
        getWorkspaceDirectoryEntries(message)
          .then((result) => {
            const payload: MainToRendererMessage = {
              type: "workspace-directory-entries-result",
              requestId,
              ok: true,
              result,
            };
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }
          })
          .catch((error) => {
            const payload: MainToRendererMessage = {
              type: "workspace-directory-entries-result",
              requestId,
              ok: false,
              errorMessage: errorMessage(error),
            };
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }
          });
        return;
      }

      if (message.type === "ipc-renderer-invoke") {
        const { channel, requestId, args } = message;
        Promise.resolve(
          bridgeState.handleRendererInvoke?.(channel, args) ??
            Promise.reject(
              new Error(
                `[ipc-bridge] no ipcMain.handle for channel ${channel}`,
              ),
            ),
        )
          .then((result) => {
            const payload: MainToRendererMessage = {
              type: "ipc-renderer-invoke-result",
              requestId,
              ok: true,
              result,
            };
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }
          })
          .catch((error) => {
            const payload: MainToRendererMessage = {
              type: "ipc-renderer-invoke-result",
              requestId,
              ok: false,
              errorMessage: errorMessage(error),
            };
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }
          });
      }
    });
  });

  setInterval(() => {
    for (const socket of sockets) {
      const missed = missedPings.get(socket) ?? 0;
      if (missed >= MAX_MISSED_PONGS) {
        socket.terminate();
        continue;
      }
      missedPings.set(socket, missed + 1);
      socket.ping();
    }
  }, SOCKET_PING_INTERVAL_MS);

  setInterval(() => {
    bridgeState.broadcastToRenderer?.({ type: "ping" });
  }, APP_PING_INTERVAL_MS);

  await app.listen({ host: options.host, port: options.port });
  console.log(`IPC bridge listening at ws://${options.host}:${options.port}`);

  ensureElectronLikeProcessContext();
  installModuleAliasHook();

  const matches = await glob("../../scratch/asar/.vite/build/main-*.js", {
    nodir: true,
    cwd: __dirname,
  });

  if (matches.length === 0) {
    throw new Error("no main bundle found");
  }

  if (matches.length > 1) {
    throw new Error("multiple main bundles found");
  }

  const module = require(matches[0]!);
  module.runMainAppStartup();
}

async function main(args: string[]) {
  const options = parseServerArgs(args, process.env);
  assertTokenRequirement(options.host, options.token);

  await startIpcBridgeServer(options);
}

main(process.argv.slice(2));
