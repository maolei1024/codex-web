export function mapBrowserPathToInitialRoute(pathname: string, search: string) {
  if (pathname === "/share/receive" && search) {
    const params = new URLSearchParams(search);

    const prompt = ["title", "text", "url"]
      .flatMap((name) => {
        const value = params.get(name);
        return value === null ? [] : [`${name}: ${value}`];
      })
      .join("\n");

    return {
      memoryPath: prompt
        ? `/?${new URLSearchParams({ prompt }).toString()}`
        : "/",
      browserPath: "/",
    };
  }

  return {
    memoryPath: mapBrowserPathToRoute(pathname, search),
  };
}

function threadHostSearch(search: string): string {
  const hostId = new URLSearchParams(search).get("hostId");
  return hostId ? `?${new URLSearchParams({ hostId }).toString()}` : "";
}

/** Migrate old Web bookmarks only when the native catalog proves ownership. */
export async function resolveLegacyThreadRoute(
  pathname: string,
  search: string,
  hosts: string[],
  readEntries: (keys: { hostId: string; threadId: string }[]) => Promise<
    {
      hostId: string;
      threadId: string;
      sourceKind: string;
    }[]
  >,
) {
  const route = mapBrowserPathToRoute(pathname, search);
  if (!route.startsWith("/local/") || threadHostSearch(search)) return null;
  const threadId = route.slice("/local/".length);
  const candidates = new Set(hosts);
  const entries = await readEntries(
    [...candidates].map((hostId) => ({ hostId, threadId })),
  );
  const matches = new Set(
    entries
      .filter(
        (entry) =>
          entry.threadId === threadId &&
          entry.sourceKind !== "chatgpt" &&
          candidates.has(entry.hostId),
      )
      .map((entry) => entry.hostId),
  );
  if (matches.size !== 1) return null;
  const query = `?${new URLSearchParams({ hostId: [...matches][0] })}`;
  return { memoryPath: `${route}${query}`, browserPath: `${pathname}${query}` };
}

function mapBrowserPathToRoute(pathname: string, search = ""): string {
  const match = pathname.match(/^\/thread\/([^/]+)$/);
  if (match) {
    try {
      return `/local/${decodeURIComponent(match[1])}${threadHostSearch(search)}`;
    } catch {
      return "/";
    }
  }

  return "/";
}

export function mapMemoryPathToBrowserPath(pathname: string, search = "") {
  if (pathname === "/") {
    return { path: "/", titleChange: "Codex" };
  }

  const match = pathname.match(/^\/local\/([^/?#]+)$/);
  if (!match) {
    return null;
  }

  return {
    path: `/thread/${encodeURIComponent(match[1])}${threadHostSearch(search)}`,
  };
}

export function dispatchNavigateToRoute(path: string): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "navigate-to-route",
        path,
      },
    }),
  );
}

window.addEventListener("popstate", () => {
  dispatchNavigateToRoute(
    mapBrowserPathToRoute(window.location.pathname, window.location.search),
  );
});
