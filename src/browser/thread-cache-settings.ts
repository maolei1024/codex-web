import type { ThreadCache } from "./thread-cache";

export function mountThreadCacheSettings(
  element: HTMLElement,
  cache: ThreadCache,
  locale?: string,
) {
  const document = element.ownerDocument;
  const zh = /^zh(?:-|$)/i.test(
    locale || document.documentElement.lang || navigator.language,
  );
  const copy = (a: string, b: string) => (zh ? a : b);
  const root = document.createElement("section");
  root.setAttribute(
    "aria-label",
    copy("对话历史缓存", "Conversation history cache"),
  );
  root.dataset.threadCacheSettings = "";
  const row = document.createElement("div");
  row.className =
    "px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between";
  const text = document.createElement("div");
  const label = document.createElement("label");
  label.className = "text-sm font-medium text-default";
  label.textContent = copy("缓存对话历史", "Cache conversation history");
  const description = document.createElement("p");
  description.className = "text-sm text-secondary";
  description.textContent = copy(
    "在此浏览器中加快再次打开对话。关闭后清除本地缓存。",
    "Open conversations faster in this browser. Turning this off clears the local cache.",
  );
  const usage = document.createElement("p");
  usage.className = "text-sm text-secondary";
  usage.setAttribute("role", "status");
  text.append(label, description, usage);
  const controls = document.createElement("div");
  controls.className = "flex flex-wrap items-center gap-3 shrink-0";
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.style.appearance = "auto";
  enabled.style.width = "20px";
  enabled.style.height = "20px";
  enabled.setAttribute("aria-label", label.textContent);
  const toggle = document.createElement("label");
  toggle.className =
    "flex items-center gap-2 text-sm text-default cursor-pointer";
  toggle.style.minHeight = "44px";
  toggle.append(enabled, document.createTextNode(copy("启用", "Enable")));
  const capacity = document.createElement("select");
  capacity.className =
    "rounded-lg px-2 text-sm text-default bg-token-main-surface-primary ring-[0.5px] ring-token-border";
  capacity.style.minHeight = "44px";
  capacity.style.appearance = "auto";
  capacity.setAttribute("aria-label", copy("缓存容量", "Cache capacity"));
  for (const size of [64, 128, 256]) {
    const option = document.createElement("option");
    option.value = String(size);
    option.textContent = `${size} MiB`;
    capacity.append(option);
  }
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className =
    "rounded-lg px-3 text-sm font-medium text-default ring-[0.5px] ring-token-border enabled:hover:bg-token-list-hover-background disabled:opacity-50";
  clear.style.minHeight = "44px";
  clear.textContent = copy("清除缓存", "Clear cache");
  clear.title = copy(
    "不影响草稿和服务端历史",
    "Does not affect drafts or server history",
  );
  controls.append(toggle, capacity, clear);
  row.append(text, controls);
  root.append(row);
  element.append(root);
  let disposed = false,
    busy = false,
    refresh = 0;
  async function render() {
    const generation = ++refresh;
    const stats = await cache.store.stats();
    if (disposed || generation !== refresh) return;
    enabled.disabled = busy;
    capacity.disabled = busy || !stats?.enabled;
    clear.disabled = busy;
    if (stats) {
      enabled.checked = stats.enabled;
      capacity.value = String(stats.capacityMiB);
      usage.textContent = copy(
        `${stats.threads} 个对话 · ${(stats.bytes / 1048576).toFixed(1)} / ${stats.capacityMiB} MiB`,
        `${stats.threads} conversations · ${(stats.bytes / 1048576).toFixed(1)} / ${stats.capacityMiB} MiB`,
      );
    } else
      usage.textContent = copy(
        "本地存储暂不可用，继续在线加载。",
        "Local storage is unavailable. Conversations load online.",
      );
  }
  async function action(fn: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    void render();
    try {
      await fn();
    } finally {
      busy = false;
      void render();
    }
  }
  enabled.onchange = () =>
    void action(() => cache.configure({ enabled: enabled.checked }));
  capacity.onchange = () =>
    void action(() =>
      cache.configure({
        capacityMiB: Number(capacity.value) as 64 | 128 | 256,
      }),
    );
  clear.onclick = () => void action(() => cache.clear());
  const off = cache.subscribe(() => void render());
  void render();
  return () => {
    disposed = true;
    off();
    root.remove();
  };
}

export function showThreadCacheSync(count: number) {
  let notice = document.querySelector<HTMLElement>("[data-thread-cache-sync]");
  if (!count) {
    notice?.remove();
    return;
  }
  if (notice) return;
  notice = document.createElement("div");
  notice.dataset.threadCacheSync = "";
  notice.setAttribute("role", "status");
  notice.className =
    "text-xs text-secondary rounded-lg bg-token-main-surface-primary";
  Object.assign(notice.style, {
    position: "fixed",
    top: "48px",
    right: "20px",
    zIndex: "40",
    padding: "6px 10px",
    pointerEvents: "none",
  });
  notice.textContent = /^zh/i.test(
    document.documentElement.lang || navigator.language,
  )
    ? "正在同步对话…"
    : "Syncing conversation…";
  document.body.append(notice);
}
