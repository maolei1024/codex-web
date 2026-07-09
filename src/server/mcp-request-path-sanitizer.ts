import path from "node:path";

// The codex app-server rejects any request in which a field typed
// `AbsolutePathBuf` holds a non-absolute path ("Invalid request:
// AbsolutePathBuf deserialized without a base path"). The upstream webview
// intermittently leaks its `~` home-directory sentinel (and can leak
// client-platform paths) into `thread/start` / `thread/resume` payloads —
// most visibly as "恢复对话失败" when reopening a thread. The desktop app has
// the same class of bug upstream (openai/codex#16815, #23209); rather than
// patching every leak site in the bundle, normalize the known
// `AbsolutePathBuf`-typed fields as requests transit the websocket bridge.
const ABSOLUTE_PATH_ARRAY_KEYS = new Set([
  "runtimeWorkspaceRoots",
  "writableRoots",
]);

export type SanitizedPathChange = {
  key: string;
  before: string;
  after: string | null;
};

export function expandTildePath(value: string, homeDir: string): string {
  if (value === "~") {
    return homeDir;
  }
  if (value.startsWith("~/")) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

function sanitizePathValue(
  value: string,
  homeDir: string,
): { keep: boolean; value: string } {
  const expanded = expandTildePath(value, homeDir);
  return { keep: path.isAbsolute(expanded), value: expanded };
}

function sanitizeNode(
  node: unknown,
  homeDir: string,
  changes: SanitizedPathChange[],
): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      sanitizeNode(item, homeDir, changes);
    }
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }

  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (ABSOLUTE_PATH_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      const sanitized: unknown[] = [];
      for (const entry of value) {
        if (typeof entry !== "string") {
          sanitized.push(entry);
          continue;
        }
        const result = sanitizePathValue(entry, homeDir);
        if (!result.keep) {
          changes.push({ key, before: entry, after: null });
          continue;
        }
        if (result.value !== entry) {
          changes.push({ key, before: entry, after: result.value });
        }
        sanitized.push(result.value);
      }
      record[key] = sanitized;
      continue;
    }

    if (key === "cwd" && typeof value === "string") {
      const expanded = expandTildePath(value, homeDir);
      if (expanded !== value) {
        changes.push({ key, before: value, after: expanded });
        record[key] = expanded;
      }
      continue;
    }

    sanitizeNode(value, homeDir, changes);
  }
}

type McpRequestEnvelope = {
  type?: unknown;
  request?: {
    method?: unknown;
    params?: unknown;
  };
};

/**
 * Rewrites, in place, non-absolute paths inside an outbound `mcp-request`
 * bridge envelope. Returns the changes made (empty when the envelope was
 * either not an mcp-request or already clean) so callers can log them.
 */
export function sanitizeMcpRequestPaths(
  argument: unknown,
  homeDir: string,
): { method: string; changes: SanitizedPathChange[] } | null {
  if (typeof argument !== "object" || argument === null) {
    return null;
  }
  const envelope = argument as McpRequestEnvelope;
  if (envelope.type !== "mcp-request") {
    return null;
  }
  const request = envelope.request;
  if (
    typeof request !== "object" ||
    request === null ||
    typeof request.method !== "string" ||
    typeof request.params !== "object" ||
    request.params === null
  ) {
    return null;
  }

  const changes: SanitizedPathChange[] = [];
  sanitizeNode(request.params, homeDir, changes);
  return changes.length > 0 ? { method: request.method, changes } : null;
}
