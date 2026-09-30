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
