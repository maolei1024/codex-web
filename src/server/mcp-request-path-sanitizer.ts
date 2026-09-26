import path from "node:path";

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
      if (
        key === "runtimeWorkspaceRoots" &&
        sanitized.length === 0 &&
        value.length > 0
      ) {
        delete record[key];
        changes.push({
          key,
          before: "(all entries dropped)",
          after: "(override removed)",
        });
        continue;
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

function requestFromEnvelope(node: unknown): {
  method: string;
  params: Record<string, unknown>;
} | null {
  if (typeof node !== "object" || node === null) {
    return null;
  }
  const envelope = node as McpRequestEnvelope;
  const request = envelope.request;
  if (
    typeof envelope.type !== "string" ||
    typeof request !== "object" ||
    request === null ||
    typeof request.method !== "string" ||
    typeof request.params !== "object" ||
    request.params === null
  ) {
    return null;
  }
  return {
    method: request.method,
    params: request.params as Record<string, unknown>,
  };
}

export function sanitizeMcpRequestPaths(
  argument: unknown,
  homeDir: string,
): { method: string; changes: SanitizedPathChange[] } | null {
  if (typeof argument !== "object" || argument === null) {
    return null;
  }

  const changes: SanitizedPathChange[] = [];
  let firstMethod: string | null = null;
  const seen = new WeakSet<object>();

  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) {
      return;
    }
    seen.add(node);

    const request = requestFromEnvelope(node);
    if (request) {
      firstMethod ??= request.method;
      sanitizeNode(request.params, homeDir, changes);
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      visit(value);
    }
  };

  visit(argument);
  return changes.length > 0 && firstMethod !== null
    ? { method: firstMethod, changes }
    : null;
}
