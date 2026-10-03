export type NativeRendererMessage = { channel: string; payload: unknown };
export type RendererSendMode = "normal" | "inline" | "critical";
export type RendererListener = (...args: unknown[]) => void;

export type RendererWebContents = {
  id: number;
  mainFrame: any;
  getURL(): string;
  isDestroyed(): boolean;
  on(event: string, listener: RendererListener): unknown;
  once(event: string, listener: RendererListener): unknown;
  off(event: string, listener: RendererListener): unknown;
  removeListener(event: string, listener: RendererListener): unknown;
  send(channel: string, ...args: unknown[]): void;
};

export type RendererConnection = {
  readonly id: string;
  readonly sender: RendererWebContents;
  readonly closed: boolean;
  close(reason?: string): void;
};

type NativePart = { transferId: string; sequence: number; kind: string };
type NativeTarget = {
  messages: unknown[];
  criticalMessages: unknown[];
  sending: boolean;
  transfer: null | {
    id: string;
    delivered: boolean;
    part: NativePart | null;
  };
};
export type NativeRendererSender = {
  targets: Map<object, NativeTarget>;
  send(target: object, message: NativeRendererMessage): void;
  sendInline(target: object, message: NativeRendererMessage): void;
  sendCritical(target: object, message: NativeRendererMessage): void;
  acknowledge(target: object, transferId: string, sequence: number): void;
  dispose(target: object): void;
};
type AckWait = {
  transferId: string;
  sequence: number;
  deliveredAt: number;
  timer: ReturnType<typeof setTimeout>;
};
type ConnectionState = {
  parent: () => object;
  deliver: (channel: string, args: unknown[], prepared?: boolean) => void;
  fail: (reason: string) => void;
  beforeClose?: () => void;
  closing: boolean;
  closed: boolean;
  destroyed: Map<RendererListener, boolean>;
  waits: Map<NativeRendererSender, AckWait>;
};
type PrepareHooks = {
  prepareGlobal?: (
    message: NativeRendererMessage,
    owner?: RendererConnection,
  ) => NativeRendererMessage | null;
  prepareConnection?: (
    connection: RendererConnection,
    message: NativeRendererMessage,
  ) => NativeRendererMessage | null;
};

/** Port proxies inherit this identity while retaining their own destroyed event. */
export const RENDERER_CONNECTION_OWNER = Symbol("codex-web-renderer-owner");
const READ_ONLY_FETCHES = new Set([
  "get-settings",
  "get-shared-object-snapshot",
  "get-global-state",
  "get-host-config",
  "get-workspace-roots",
  "get-remote-connections",
  "workspace-root-options",
  "codex-home",
  "codex-home-paths",
  "app-server-connection-state",
  "locale-info",
  "get-configuration",
  "is-copilot-api-available",
  "get-copilot-api-proxy-info",
  "read-file-binary",
  "read-file-metadata",
  "paths-exist",
]);

/** Native window identity is shared; delivery queues and ACKs belong to a socket. */
export class RendererConnectionHub {
  private sequence = 0;
  private connections = new Set<RendererConnection>();
  private states = new WeakMap<RendererConnection, ConnectionState>();
  private owners = new WeakMap<object, RendererConnection>();
  private senders = new Set<NativeRendererSender>();
  private hooks: PrepareHooks = {};
  private ackTimeouts = 0;
  private readonly ackTimeoutMs: number;

  constructor({ ackTimeoutMs = 30_000 } = {}) {
    if (!Number.isFinite(ackTimeoutMs) || ackTimeoutMs <= 0)
      throw new Error("ACK timeout must be positive");
    this.ackTimeoutMs = ackTimeoutMs;
  }

  configure(hooks: PrepareHooks): void {
    this.hooks = hooks;
  }

  createConnection({
    parent,
    deliver,
    fail,
    beforeClose,
  }: {
    parent: () => object;
    deliver: (channel: string, args: unknown[], prepared?: boolean) => void;
    fail: (reason: string) => void;
    beforeClose?: () => void;
  }): RendererConnection {
    const state: ConnectionState = {
      parent,
      deliver,
      fail,
      beforeClose,
      closing: false,
      closed: false,
      destroyed: new Map(),
      waits: new Map(),
    };
    let connection: RendererConnection;
    const sender = new Proxy({} as RendererWebContents, {
      get: (_target, key) => {
        if (key === RENDERER_CONNECTION_OWNER) return connection;
        if (key === "isDestroyed")
          return () => state.closed || this.destroyed(state.parent());
        if (key === "send")
          return (channel: string, ...args: unknown[]) => {
            if (!state.closed) state.deliver(channel, args, false);
          };
        if (["on", "once", "addListener"].includes(String(key)))
          return (event: string, listener: RendererListener) => {
            if (event === "destroyed") {
              if (!state.closed) state.destroyed.set(listener, key === "once");
              return sender;
            }
            const source = state.parent() as Record<string, any>;
            return source[String(key)]?.call(source, event, listener);
          };
        if (["off", "removeListener"].includes(String(key)))
          return (event: string, listener: RendererListener) => {
            if (event === "destroyed") {
              state.destroyed.delete(listener);
              return sender;
            }
            const source = state.parent() as Record<string, any>;
            return source[String(key)]?.call(source, event, listener);
          };
        const source = state.parent();
        const value = Reflect.get(source, key, source);
        return typeof value === "function" ? value.bind(source) : value;
      },
    });
    connection = {
      id: `web-renderer-${++this.sequence}`,
      sender,
      get closed() {
        return state.closed;
      },
      close: () => this.closeConnection(connection),
    };
    this.states.set(connection, state);
    this.owners.set(sender, connection);
    this.connections.add(connection);
    return connection;
  }

  bindOwner(target: object, connection: RendererConnection): void {
    if (!this.states.has(connection))
      throw new Error("Unknown renderer connection");
    this.owners.set(target, connection);
  }

  ownerOf(target: object): RendererConnection | undefined {
    const owner =
      this.owners.get(target) ?? Reflect.get(target, RENDERER_CONNECTION_OWNER);
    return owner && this.states.has(owner) ? owner : undefined;
  }

  /** Prepare intact messages once, then enqueue separately for each recipient. */
  send(
    native: NativeRendererSender,
    target: object,
    message: NativeRendererMessage,
    mode: RendererSendMode,
  ): void {
    const owner = this.ownerOf(target);
    if (this.destroyed(target) || owner?.closed) return;
    const prepared =
      this.hooks.prepareGlobal?.(message, owner) ??
      (this.hooks.prepareGlobal ? null : message);
    if (!prepared) return;
    const recipients = owner
      ? [owner]
      : [...this.connections].filter(
          (connection) => connection.sender.id === Reflect.get(target, "id"),
        );
    for (const connection of recipients) {
      if (connection.closed || connection.sender.isDestroyed()) continue;
      const scoped =
        this.hooks.prepareConnection?.(connection, prepared) ??
        (this.hooks.prepareConnection ? null : prepared);
      if (!scoped) continue;
      this.senders.add(native);
      if (mode === "critical") native.sendCritical(connection.sender, scoped);
      else if (mode === "inline") native.sendInline(connection.sender, scoped);
      else native.send(connection.sender, scoped);
    }
  }

  /** Native messages were prepared before encoding; deliver them exactly once. */
  deliver(
    native: NativeRendererSender,
    target: object,
    message: NativeRendererMessage,
    part: NativePart | null,
  ): void {
    const owner = this.ownerOf(target);
    if (!owner || owner.closed || this.destroyed(target)) return;
    this.states
      .get(owner)!
      .deliver(message.channel, [part ?? message.payload], true);
    this.delivered(native, target, part);
  }

  /** Called only after the actual native part was delivered successfully. */
  delivered(
    native: NativeRendererSender,
    target: object,
    part: NativePart | null,
  ): void {
    if (!part) return;
    const owner = this.ownerOf(target);
    if (!owner || owner.closed) return;
    const state = this.states.get(owner)!;
    this.clearWait(state, native);
    const wait: AckWait = {
      transferId: part.transferId,
      sequence: part.sequence,
      deliveredAt: Date.now(),
      timer: setTimeout(() => {
        if (owner.closed || state.waits.get(native) !== wait) return;
        const transfer = native.targets.get(owner.sender)?.transfer;
        if (
          !transfer ||
          transfer.id !== wait.transferId ||
          transfer.part?.sequence !== wait.sequence ||
          !transfer.delivered
        ) {
          this.clearWait(state, native);
          return;
        }
        this.ackTimeouts++;
        this.closeConnection(owner);
        try {
          state.fail("Native message acknowledgement timed out");
        } catch {}
      }, this.ackTimeoutMs),
    };
    wait.timer.unref?.();
    state.waits.set(native, wait);
    this.senders.add(native);
  }

  acknowledge(
    native: NativeRendererSender,
    source: object,
    transferId: string,
    sequence: number,
  ): void {
    const owner = this.ownerOf(source);
    if (!owner || owner.closed || this.destroyed(source)) return;
    const target = native.targets.get(owner.sender);
    const transfer = target?.transfer;
    // Match the native acceptance condition; unrelated/late ACKs change no deadline.
    if (
      !target ||
      target.sending ||
      !transfer?.delivered ||
      transfer.id !== transferId ||
      transfer.part?.sequence !== sequence
    )
      return;
    this.clearWait(this.states.get(owner)!, native);
    native.acknowledge(owner.sender, transferId, sequence);
  }

  requestKey(target: object, requestId: string): string {
    const owner = this.ownerOf(target);
    return owner
      ? JSON.stringify([owner.id, requestId])
      : `${String(Reflect.get(target, "id"))}:${requestId}`;
  }

  /** Only read callers are cancelled; a disconnected browser never stops a turn. */
  trackRead(
    source: RendererWebContents,
    url: string,
    controller: AbortController,
    release: () => void,
  ): () => void {
    if (
      !this.ownerOf(source) ||
      !url.startsWith("vscode://codex/") ||
      !READ_ONLY_FETCHES.has(url.slice("vscode://codex/".length))
    )
      return () => {};
    const remove = () => source.removeListener("destroyed", abort);
    const abort = () => {
      remove();
      controller.abort(new Error("Renderer connection closed"));
      release();
    };
    if (source.isDestroyed()) abort();
    else source.once("destroyed", abort);
    return remove;
  }

  diagnostics() {
    let targets = 0,
      queuedMessages = 0,
      criticalQueuedMessages = 0;
    let pendingTransfers = 0,
      oldestAckWaitMs = 0;
    const now = Date.now();
    for (const connection of this.connections) {
      const state = this.states.get(connection)!;
      for (const native of this.senders) {
        const target = native.targets.get(connection.sender);
        if (!target) continue;
        targets++;
        queuedMessages += target.messages.length;
        criticalQueuedMessages += target.criticalMessages.length;
        if (target.transfer) pendingTransfers++;
      }
      for (const wait of state.waits.values())
        oldestAckWaitMs = Math.max(oldestAckWaitMs, now - wait.deliveredAt);
    }
    return {
      connections: this.connections.size,
      targets,
      queuedMessages,
      criticalQueuedMessages,
      pendingTransfers,
      oldestAckWaitMs,
      ackTimeouts: this.ackTimeouts,
    };
  }

  private destroyed(target: object): boolean {
    const method = Reflect.get(target, "isDestroyed");
    return typeof method === "function" && method.call(target) === true;
  }

  private clearWait(
    state: ConnectionState,
    native: NativeRendererSender,
  ): void {
    const wait = state.waits.get(native);
    if (wait) clearTimeout(wait.timer);
    state.waits.delete(native);
  }

  private closeConnection(connection: RendererConnection): void {
    const state = this.states.get(connection)!;
    if (state.closed || state.closing) return;
    state.closing = true;
    // Internal cancellation retains this connection's native identity and key.
    // It must run synchronously before closed senders fail the Desktop trust check.
    try {
      state.beforeClose?.();
    } catch {}
    state.closed = true;
    this.connections.delete(connection);
    for (const native of state.waits.keys()) this.clearWait(state, native);
    // Disposal is explicit even when a native test/adapter lacks event subscriptions.
    for (const native of this.senders) {
      try {
        native.dispose(connection.sender);
      } catch {}
    }
    for (const listener of [...state.destroyed.keys()]) {
      try {
        listener();
      } catch {
        /* One listener cannot retain another socket's state. */
      }
    }
    state.destroyed.clear();
  }
}

export const rendererConnections = new RendererConnectionHub();
(globalThis as any).__CODEX_WEB_RENDERERS__ = rendererConnections;
