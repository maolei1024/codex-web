export type NotificationSound = string | { fileName: string; name?: string };
export type CompletionNotification = {
  id: string;
  title: string;
  hostId?: string;
  conversationId?: string;
  turnId?: string;
  navigationPath: string;
  navigationState?: { activateTabId: string };
  turnMode: "off" | "unfocused" | "always";
  sound: NotificationSound;
  status?: string;
};
export type CompletionOptions = {
  signal?: AbortSignal;
  onOpen?: (action: {
    id: null;
    type: "open";
  }) =>
    | { path: string; state?: unknown }
    | Promise<{ path: string; state?: unknown }>;
};
export type BrowserNotificationState = {
  supported: boolean;
  permission: string;
  audioState: "locked" | "ready" | "unavailable";
  volume: number;
  dedupAvailable: boolean;
  error?: string;
};
type Effect = "audio" | "notification";
type PreviewSound = (
  sound: NotificationSound,
  callback: (bytes: unknown) => Promise<boolean>,
) => Promise<boolean>;
type NotificationLike = {
  onclick: ((event: Event) => void) | null;
  close(): void;
};
type ChannelLike = {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    callback: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(
    type: "message",
    callback: (event: { data: unknown }) => void,
  ): void;
  close(): void;
};
export type NotificationEnvironment = {
  now(): number;
  randomId(): string;
  supported: boolean;
  permission(): string;
  requestPermission(): Promise<string>;
  focused(): boolean;
  createNotification(
    title: string,
    options: NotificationOptions,
  ): NotificationLike;
  createAudioContext?: () => AudioContext;
  storage?: Pick<Storage, "getItem" | "setItem">;
  ledger?: { claim(id: string, effect: Effect, now: number): Promise<boolean> };
  channel?: ChannelLike;
  wait(ms: number): Promise<void>;
  listenActivity(callback: () => void): () => void;
  focus(): void;
  navigate(path: string, state?: unknown): void;
  warn(message: string): void;
};

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 1000;
const VOLUME_KEY = "codex-web-notification-volume";
const PRESENCE_WAIT_MS = 120;

/** A transaction serializes competing tabs; unique compound keys claim each effect. */
export class IndexedDbNotificationLedger {
  private database?: Promise<IDBDatabase>;
  constructor(
    private readonly factory: IDBFactory,
    private readonly timeoutMs = 3000,
  ) {}
  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise((resolve, reject) => {
        const request = this.factory.open("codex-web-notifications", 1);
        let finished = false;
        const fail = (error: Error | DOMException) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          reject(error);
        };
        const timer = setTimeout(() => {
          try {
            request.transaction?.abort();
          } catch {}
          fail(new Error("Notification storage open timed out"));
        }, this.timeoutMs);
        request.onupgradeneeded = () => {
          if (finished) {
            request.transaction?.abort();
            return;
          }
          const events = request.result.createObjectStore("events", {
            keyPath: "id",
          });
          events.createIndex("at", "at");
          const effects = request.result.createObjectStore("effects", {
            keyPath: ["id", "effect"],
          });
          effects.createIndex("id", "id");
        };
        request.onsuccess = () => {
          const db = request.result;
          if (finished) {
            db.close();
            return;
          }
          finished = true;
          clearTimeout(timer);
          db.onversionchange = () => {
            db.close();
            this.database = undefined;
          };
          resolve(db);
        };
        request.onerror = () =>
          fail(request.error ?? new Error("Notification storage unavailable"));
        request.onblocked = () =>
          fail(new Error("Notification storage upgrade blocked"));
      });
    }
    return this.database;
  }
  async claim(id: string, effect: Effect, now: number): Promise<boolean> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["events", "effects"], "readwrite");
      const timeout = setTimeout(() => {
        // An eventual persistent claim must not follow page-local fallback.
        try {
          transaction.abort();
        } catch {}
        reject(new Error("Notification storage claim timed out"));
      }, this.timeoutMs);
      const events = transaction.objectStore("events");
      const effects = transaction.objectStore("effects");
      let claimed = false;
      const existing = events.get(id);
      existing.onsuccess = () => {
        const expired = existing.result?.at <= now - RETENTION_MS;
        if (expired) {
          effects.delete([id, "audio"]);
          effects.delete([id, "notification"]);
        }
        if (existing.result == null || expired) events.put({ id, at: now });
        const add = effects.add({ id, effect, at: now });
        add.onsuccess = () => {
          claimed = true;
        };
        add.onerror = (event) => {
          if (add.error?.name === "ConstraintError") {
            event.preventDefault();
            event.stopPropagation();
          }
        };
        const count = events.count();
        count.onsuccess = () => {
          let excess = Math.max(0, count.result - MAX_EVENTS);
          const cursor = events.index("at").openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row || (row.value.at > now - RETENTION_MS && excess === 0))
              return;
            if (row.value.id === id) {
              row.continue();
              return;
            }
            row.delete();
            if (excess > 0) excess--;
            const keys = effects.index("id").openKeyCursor(row.value.id);
            keys.onsuccess = () => {
              const key = keys.result;
              if (key) {
                effects.delete(key.primaryKey);
                key.continue();
              }
            };
            row.continue();
          };
        };
      };
      transaction.oncomplete = () => {
        clearTimeout(timeout);
        resolve(claimed);
      };
      transaction.onerror = () => {
        clearTimeout(timeout);
        reject(transaction.error ?? new Error("Notification storage failed"));
      };
      transaction.onabort = () => {
        clearTimeout(timeout);
        reject(transaction.error ?? new Error("Notification storage aborted"));
      };
    });
  }
}

/** Notification routes carry host identity, never authentication query parameters. */
export function notificationNavigationPath(
  path: string,
  hostId?: string,
): string | null {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//")
  )
    return null;
  try {
    const url = new URL(path, "https://codex-web.invalid");
    if (url.origin !== "https://codex-web.invalid") return null;
    const host = hostId || url.searchParams.get("hostId");
    const search = host ? `?${new URLSearchParams({ hostId: host })}` : "";
    return `${url.pathname}${search}`;
  } catch {
    return null;
  }
}

function soundKey(sound: NotificationSound): string {
  return typeof sound === "string" ? sound : sound.fileName;
}
function copyBytes(bytes: unknown): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes.slice(0);
  if (ArrayBuffer.isView(bytes)) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return copy.buffer;
  }
  if (
    Array.isArray(bytes) &&
    bytes.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)
  ) {
    return new Uint8Array(bytes).buffer;
  }
  throw new Error("Invalid notification audio bytes");
}
function completionInput(value: unknown): CompletionNotification | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== "string" ||
    !v.id ||
    v.id.length > 8192 ||
    typeof v.title !== "string" ||
    typeof v.navigationPath !== "string" ||
    !["off", "unfocused", "always"].includes(v.turnMode as string)
  )
    return null;
  const sound = v.sound;
  if (
    !(
      typeof sound === "string" ||
      (sound &&
        typeof sound === "object" &&
        typeof (sound as { fileName?: unknown }).fileName === "string")
    )
  )
    return null;
  const hostId = typeof v.hostId === "string" ? v.hostId : undefined;
  const path = notificationNavigationPath(v.navigationPath, hostId);
  if (!path) return null;
  const state = v.navigationState as { activateTabId?: unknown } | undefined;
  // Deliberately whitelist fields: assistant text and callback objects never cross tabs.
  return {
    id: v.id,
    title: v.title.slice(0, 300),
    navigationPath: path,
    navigationState:
      state && typeof state.activateTabId === "string"
        ? { activateTabId: state.activateTabId }
        : undefined,
    hostId,
    conversationId:
      typeof v.conversationId === "string" ? v.conversationId : undefined,
    turnId: typeof v.turnId === "string" ? v.turnId : undefined,
    turnMode: v.turnMode as CompletionNotification["turnMode"],
    sound:
      typeof sound === "string"
        ? sound
        : { fileName: (sound as { fileName: string }).fileName },
    status: typeof v.status === "string" ? v.status : undefined,
  };
}

export class BrowserNotificationsController {
  private readonly tabId: string;
  private readonly listeners = new Set<() => void>();
  private readonly seen = new Map<string, number>();
  private readonly localClaims = new Map<string, number>();
  private readonly errors = new Map<string, string>();
  private readonly warnings = new Set<string>();
  private readonly presence = new Map<string, { focused: boolean }>();
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private readonly sources = new Set<AudioBufferSourceNode>();
  private context?: AudioContext;
  private gain?: GainNode;
  private previewSound?: PreviewSound;
  private volume = 0.3;
  private dedupAvailable: boolean;
  private readonly removeActivity: () => void;
  private presenceCounter = 0;
  private disposed = false;
  constructor(private readonly env: NotificationEnvironment) {
    this.tabId = env.randomId();
    this.dedupAvailable = !!env.ledger;
    this.readVolume();
    this.removeActivity = env.listenActivity(() => {
      this.readVolume();
      this.changed();
    });
    env.channel?.addEventListener("message", this.onMessage);
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  private report(kind: string, message: string, warn = true): void {
    this.errors.set(kind, message);
    if (warn && !this.warnings.has(message)) {
      this.warnings.add(message);
      this.env.warn(message);
    }
    this.changed();
  }
  private readVolume(): void {
    try {
      const saved = this.env.storage?.getItem(VOLUME_KEY);
      if (saved != null && saved !== "") {
        const number = Number(saved);
        if (Number.isFinite(number))
          this.volume = Math.min(1, Math.max(0, number));
      }
      if (this.gain) this.gain.gain.value = this.volume;
    } catch {
      /* Keep the current page's usable volume when storage is blocked. */
    }
  }
  getState(): BrowserNotificationState {
    return {
      supported: this.env.supported,
      permission: this.env.supported ? this.env.permission() : "unsupported",
      audioState: !this.env.createAudioContext
        ? "unavailable"
        : this.context?.state === "running"
          ? "ready"
          : "locked",
      volume: this.volume,
      dedupAvailable: this.dedupAvailable,
      error: [...this.errors.values()].at(-1),
    };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  setPreviewSound(fn: PreviewSound): void {
    this.previewSound = fn;
  }
  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.gain) this.gain.gain.value = this.volume;
    try {
      this.env.storage?.setItem(VOLUME_KEY, String(this.volume));
      this.errors.delete("volume");
    } catch {
      this.report("volume", "提示音音量无法保存；当前页面仍使用所选音量。");
    }
    this.post({ type: "volume", value: this.volume });
    this.changed();
  }
  /** Creation and resume run before the first await, preserving the click gesture. */
  async unlockAudio(): Promise<boolean> {
    if (this.disposed || !this.env.createAudioContext) return false;
    try {
      if (!this.context || this.context.state === "closed") {
        this.context = this.env.createAudioContext();
        this.gain = this.context.createGain();
        this.gain.gain.value = this.volume;
        this.gain.connect(this.context.destination);
        this.context.addEventListener?.("statechange", () => this.changed());
        this.buffers.clear();
      }
      const resume =
        this.context.state === "running" ? undefined : this.context.resume();
      if (resume) await resume;
      const ready = this.context.state === "running";
      if (ready) this.errors.delete("audio");
      this.changed();
      return ready;
    } catch {
      this.report("audio", "浏览器暂时无法播放提示音，请再次点击启用或试听。");
      return false;
    }
  }
  async requestPermission(): Promise<string> {
    if (!this.env.supported) return "unsupported";
    try {
      const permission =
        this.env.permission() === "default"
          ? await this.env.requestPermission()
          : this.env.permission();
      if (permission === "granted") this.errors.delete("permission");
      this.changed();
      return permission;
    } catch {
      this.report("permission", "浏览器无法请求通知权限，请检查站点设置。");
      return this.env.permission();
    }
  }
  private async soundBuffer(sound: NotificationSound): Promise<AudioBuffer> {
    const key = soundKey(sound);
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = (async () => {
        if (!this.previewSound || !this.context)
          throw new Error("Audio service unavailable");
        let bytes: ArrayBuffer | undefined;
        await this.previewSound(sound, async (value) => {
          bytes = copyBytes(value);
          return true;
        });
        if (!bytes) throw new Error("Notification sound unavailable");
        return this.context.decodeAudioData(bytes);
      })();
      this.buffers.set(key, buffer);
      void buffer.catch(() => {
        if (this.buffers.get(key) === buffer) this.buffers.delete(key);
      });
    }
    return buffer;
  }
  private playBuffer(buffer: AudioBuffer, signal?: AbortSignal): boolean {
    if (
      this.disposed ||
      signal?.aborted ||
      this.context?.state !== "running" ||
      !this.gain
    )
      return false;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
    };
    try {
      source.start();
    } catch (error) {
      this.sources.delete(source);
      source.disconnect();
      throw error;
    }
    if (this.errors.delete("audio")) this.changed();
    return true;
  }
  async playBytes(bytes: unknown, signal?: AbortSignal): Promise<boolean> {
    if (this.context?.state !== "running" || signal?.aborted || this.disposed)
      return false;
    try {
      const buffer = await this.context.decodeAudioData(copyBytes(bytes));
      return this.playBuffer(buffer, signal);
    } catch {
      this.report("audio", "提示音播放失败，请再次试听。");
      return false;
    }
  }
  async preview(sound: NotificationSound): Promise<boolean> {
    const unlock = this.unlockAudio();
    if (sound === "none" || !(await unlock)) return false;
    try {
      return this.playBuffer(await this.soundBuffer(sound));
    } catch {
      this.report("audio", "无法读取提示音，请检查连接后再次试听。");
      return false;
    }
  }
  private post(message: object): void {
    try {
      this.env.channel?.postMessage({ ...message, source: this.tabId });
    } catch {
      /* Atomic storage still prevents duplicate effects if the channel closes. */
    }
  }
  private readonly onMessage = (event: { data: unknown }): void => {
    if (this.disposed || !event.data || typeof event.data !== "object") return;
    const message = event.data as Record<string, unknown>;
    if (message.source === this.tabId) return;
    if (message.type === "completed") {
      const input = completionInput(message.input);
      if (input) void this.receive(input, undefined, false);
    } else if (
      message.type === "presence-request" &&
      typeof message.requestId === "string"
    ) {
      this.post({
        type: "presence",
        requestId: message.requestId,
        focused: this.env.focused(),
      });
    } else if (
      message.type === "presence" &&
      typeof message.requestId === "string"
    ) {
      const check = this.presence.get(message.requestId);
      if (check && message.focused === true) check.focused = true;
    } else if (
      message.type === "volume" &&
      typeof message.value === "number" &&
      Number.isFinite(message.value)
    ) {
      this.volume = Math.min(1, Math.max(0, message.value));
      if (this.gain) this.gain.gain.value = this.volume;
      this.changed();
    }
  };
  private async anyFocused(): Promise<boolean> {
    if (this.env.focused()) return true;
    if (!this.env.channel) return false;
    const requestId = `${this.tabId}:${++this.presenceCounter}`;
    const check = { focused: false };
    this.presence.set(requestId, check);
    this.post({ type: "presence-request", requestId });
    try {
      await this.env.wait(PRESENCE_WAIT_MS);
    } finally {
      this.presence.delete(requestId);
    }
    return check.focused || this.env.focused();
  }
  private trim(map: Map<string, number>, maximum: number): void {
    const cutoff = this.env.now() - RETENTION_MS;
    for (const [id, at] of map) {
      if (at <= cutoff || map.size > maximum) map.delete(id);
      else break;
    }
  }
  private async claim(id: string, effect: Effect): Promise<boolean> {
    const key = JSON.stringify([id, effect]);
    this.trim(this.localClaims, MAX_EVENTS * 2);
    if (this.localClaims.has(key)) return false;
    if (this.dedupAvailable) {
      try {
        const claimed = await this.env.ledger!.claim(
          id,
          effect,
          this.env.now(),
        );
        if (claimed) this.localClaims.set(key, this.env.now());
        return claimed;
      } catch {
        this.dedupAvailable = false;
      }
    }
    this.report(
      "dedup",
      "浏览器通知存储不可用，当前仅在本页面去重；多个标签页可能重复提醒。",
    );
    if (this.localClaims.has(key)) return false;
    this.localClaims.set(key, this.env.now());
    return true;
  }
  complete(
    input: CompletionNotification,
    options?: CompletionOptions,
  ): Promise<void> {
    const clean = completionInput(input);
    return clean ? this.receive(clean, options, true) : Promise.resolve();
  }
  private async receive(
    input: CompletionNotification,
    options: CompletionOptions | undefined,
    broadcast: boolean,
  ): Promise<void> {
    if (
      this.disposed ||
      options?.signal?.aborted ||
      (input.status != null && input.status !== "completed")
    )
      return;
    this.trim(this.seen, MAX_EVENTS);
    if (this.seen.has(input.id)) return;
    this.seen.set(input.id, this.env.now());
    if (broadcast) this.post({ type: "completed", input });
    await Promise.all([
      this.audio(input, options),
      this.notification(input, options),
    ]);
  }
  private async audio(
    input: CompletionNotification,
    options?: CompletionOptions,
  ): Promise<void> {
    if (
      input.sound === "none" ||
      this.volume === 0 ||
      this.context?.state !== "running" ||
      options?.signal?.aborted
    )
      return;
    try {
      const buffer = await this.soundBuffer(input.sound);
      if (
        this.disposed ||
        options?.signal?.aborted ||
        this.context?.state !== "running"
      )
        return;
      if (await this.claim(input.id, "audio"))
        this.playBuffer(buffer, options?.signal);
    } catch {
      this.report("audio", "无法读取提示音，请检查连接后再次试听。");
    }
  }
  private async notification(
    input: CompletionNotification,
    options?: CompletionOptions,
  ): Promise<void> {
    if (
      input.turnMode === "off" ||
      !this.env.supported ||
      this.env.permission() !== "granted" ||
      options?.signal?.aborted
    )
      return;
    if (input.turnMode === "unfocused" && (await this.anyFocused())) return;
    if (
      this.disposed ||
      options?.signal?.aborted ||
      this.env.permission() !== "granted"
    )
      return;
    try {
      if (
        !(await this.claim(input.id, "notification")) ||
        this.disposed ||
        options?.signal?.aborted
      )
        return;
      const notification = this.env.createNotification(input.title || "Codex", {
        body: "AI 已完成。",
        silent: true,
        tag: input.id,
      });
      if (this.errors.delete("permission")) this.changed();
      notification.onclick = () => {
        this.env.focus();
        notification.close();
        void (async () => {
          let path = input.navigationPath;
          let state: unknown = input.navigationState;
          try {
            const route = await options?.onOpen?.({ id: null, type: "open" });
            if (route) {
              path =
                notificationNavigationPath(route.path, input.hostId) ?? path;
              state = route.state;
            }
          } catch {
            /* A disconnected RPC cannot prevent opening the preserved host route. */
          }
          this.env.navigate(path, state);
        })();
      };
    } catch {
      this.report("permission", "系统通知发送失败；提示音仍可独立使用。");
    }
  }
  dispose(): void {
    this.disposed = true;
    this.removeActivity();
    this.env.channel?.removeEventListener("message", this.onMessage);
    this.env.channel?.close();
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {}
    }
    this.sources.clear();
    if (this.context) void this.context.close().catch(() => {});
    this.listeners.clear();
  }
}

function browserEnvironment(): NotificationEnvironment {
  const supported =
    window.isSecureContext && typeof window.Notification === "function";
  const Audio =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  let storage: Storage | undefined;
  let ledger: IndexedDbNotificationLedger | undefined;
  let channel: BroadcastChannel | undefined;
  try {
    storage = window.localStorage;
  } catch {}
  try {
    if (window.indexedDB)
      ledger = new IndexedDbNotificationLedger(window.indexedDB);
  } catch {}
  try {
    if (typeof BroadcastChannel === "function")
      channel = new BroadcastChannel("codex-web-notifications");
  } catch {}
  return {
    now: Date.now,
    randomId: () => window.crypto.randomUUID(),
    supported,
    permission: () =>
      supported ? window.Notification.permission : "unsupported",
    requestPermission: () => window.Notification.requestPermission(),
    focused: () =>
      document.visibilityState === "visible" && document.hasFocus(),
    createNotification: (title, options) =>
      new window.Notification(title, options),
    createAudioContext: Audio ? () => new Audio() : undefined,
    storage,
    ledger,
    channel,
    wait: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    listenActivity(callback) {
      const storageChanged = (event: StorageEvent) => {
        if (event.key === VOLUME_KEY) callback();
      };
      window.addEventListener("focus", callback);
      window.addEventListener("blur", callback);
      document.addEventListener("visibilitychange", callback);
      window.addEventListener("storage", storageChanged);
      return () => {
        window.removeEventListener("focus", callback);
        window.removeEventListener("blur", callback);
        document.removeEventListener("visibilitychange", callback);
        window.removeEventListener("storage", storageChanged);
      };
    },
    focus: () => window.focus(),
    navigate(path, state) {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "navigate-to-route", path, state },
        }),
      );
    },
    warn: (message) => console.warn(`[codex-web notifications] ${message}`),
  };
}
let installed: BrowserNotificationsController | undefined;
export function installBrowserNotifications(): BrowserNotificationsController {
  return (installed ??= new BrowserNotificationsController(
    browserEnvironment(),
  ));
}
