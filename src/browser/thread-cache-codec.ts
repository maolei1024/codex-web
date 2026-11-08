import type { CachePage } from "./thread-cache-store";

const excluded =
  /^(?:authorization|auth|accessToken|refreshToken|apiKey|api_key|password|secret|cookie|headers|rpc|requests|externalRequests|draft|attachments|imageData|audioData|base64|blob)$/i;
/** Copy JSON display data; never retain binary URLs, RPC handles or credentials. */
export function displayData(value: unknown, depth = 0): any {
  if (depth > 64 || value === undefined) return undefined;
  if (typeof value === "string")
    return /^(?:data:|blob:)/i.test(value) ? undefined : value;
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (Array.isArray(value))
    return Array.from(value, (v) => displayData(v, depth + 1) ?? null);
  if (
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return undefined;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (excluded.test(key) || key === "__proto__" || key === "constructor")
      continue;
    const next = displayData(child, depth + 1);
    if (next !== undefined) copy[key] = next;
  }
  return copy;
}

export type TurnPage = {
  schema: 1;
  turnId: string;
  offset: number;
  total: number;
  details: Record<string, any>;
  metadata?: { title?: string; createdAt?: number; updatedAt?: number };
  items: any[];
  boundary: unknown;
};

export function turnDetails(turn: any) {
  const result: Record<string, any> = {
    params: {
      input: (turn.params?.input ?? []).filter(
        (item: any) => item?.type !== "image" && item?.type !== "localImage",
      ),
      clientUserMessageId: turn.params?.clientUserMessageId,
      commentAttachments: turn.params?.commentAttachments,
    },
  };
  for (const key of [
    "turnId",
    "status",
    "error",
    "turnStartedAtMs",
    "turnCompletedAtMs",
    "itemsPagination",
    "interruptedCommandExecutionItemIds",
  ])
    if (turn[key] !== undefined) result[key] = turn[key];
  return result;
}

export function encodePage(
  id: string,
  order: number,
  data: TurnPage,
): CachePage {
  const json = JSON.stringify(displayData(data));
  return {
    id,
    order,
    json,
    bytes:
      new TextEncoder().encode(json).byteLength +
      new TextEncoder().encode(id).byteLength +
      96,
  };
}

export function decodePage(page: CachePage): TurnPage {
  if (page.bytes < new TextEncoder().encode(page.json).byteLength)
    throw new Error("CorruptPage");
  const value = JSON.parse(page.json);
  if (
    value?.schema !== 1 ||
    typeof value.turnId !== "string" ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.details?.params?.input) ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    !Number.isSafeInteger(value.total) ||
    value.total < value.items.length + value.offset ||
    value.items.some(
      (item: any) =>
        item !== null &&
        (typeof item.id !== "string" || typeof item.type !== "string"),
    )
  )
    throw new Error("CorruptPage");
  return value;
}

/** A partially retained turn is shown only as a whole loaded page, with its real boundary. */
export function restoreTurns(pages: TurnPage[]): any[] {
  const groups = new Map<string, TurnPage[]>();
  for (const page of pages) {
    const group = groups.get(page.turnId) ?? [];
    group.push(page);
    groups.set(page.turnId, group);
  }
  return [...groups.values()].flatMap((group) => {
    group.sort((a, b) => a.offset - b.offset);
    // Keep the newest contiguous set of complete loaded pages. A missing page
    // remains an online pagination boundary; individual messages are never cut.
    let first = group.length - 1;
    while (
      first > 0 &&
      group[first - 1]!.offset + group[first - 1]!.items.length ===
        group[first]!.offset
    )
      first--;
    const tail = group.slice(first),
      last = tail.at(-1)!;
    const complete =
      tail[0]!.offset === 0 &&
      last.offset + last.items.length ===
        Math.max(...group.map((p) => p.total));
    return [
      {
        ...last.details,
        ...(complete
          ? {}
          : {
              itemsPagination: {
                ...last.details.itemsPagination,
                hasLoadedOldest: false,
              },
            }),
        items: tail.flatMap((p) => p.items),
      },
    ];
  });
}
