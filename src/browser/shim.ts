import {
  mapBrowserPathToInitialRoute,
  mapMemoryPathToBrowserPath,
} from "./routes";
import {
  handleLocalFilePickerMessage,
  installBrowserFileUploadBridge,
  isLocalFilePickerMessage,
} from "./files";
import { getUploadedFilePath } from "./uploaded-file-paths";
import { imageDrafts } from "./image-drafts";
import { installMobileViewportGuard } from "./mobile-viewport";
import { reconnectDelayMs } from "./reconnect";
import { RpcLifecycle, isTransportFailure } from "./rpc-lifecycle";
import { ReconnectRecovery } from "./reconnect-recovery";
import { ConnectionWatchdog } from "./connection-watchdog";
import {
  SharedObjectSubscriptions,
  SHARED_OBJECT_CHANNEL,
} from "./shared-object-subscriptions";
import { downloadErrorMessage, wrapBrowserServices } from "./downloads";
import {
  adaptDesktopBridge,
  desktopCapabilityOverrides,
} from "./desktop-capabilities";
import {
  clearStatsigSnapshots,
  configureStatsigClient,
  type StatsigClientLike,
} from "./statsig-cache";
import {
  openSelectWorkspaceRootDialog,
  type WorkspaceDirectoryEntries,
} from "./workspace-root-dialog";

type IpcListener = (event: unknown, ...args: unknown[]) => void;

type RendererToMainMessage =
  | { type: "bridge-ping"; requestId: string }
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
    };

type MainToRendererMessage =
  | { type: "bridge-pong"; requestId: string }
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
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    };

type MemoryNavigationChange = {
  action: "POP" | "PUSH" | "REPLACE";
  delta: number;
  location: {
    hash: string;
    key: string;
    pathname: string;
    search: string;
    state: unknown;
  };
};

type ElectronShimState = {
  appServerRequestLifecycle?: RpcLifecycle["onLifecycle"];
  isTransportFailure?: typeof isTransportFailure;
  imageDrafts?: typeof imageDrafts;
  wrapBrowserServices?: typeof wrapBrowserServices;
  downloadErrorMessage?: typeof downloadErrorMessage;
  configureStatsigClient?: <T extends StatsigClientLike>(
    client: T,
    sdkKey: string,
  ) => T;
  initialRoute?: string;
  initialSidebarState?: boolean;
  closeSidebar?: () => void;
  onMemoryNavigationChanged?: (navigation: MemoryNavigationChange) => void;
  overrideAdapter?: typeof desktopCapabilityOverrides;
};

declare global {
  interface Window {
    __ELECTRON_SHIM__?: ElectronShimState;
  }
}

declare const __CODEX_APP_VERSION__: string;
declare const __CODEX_WEB_BUILD_ID__: string;

let requestCounter = 0;
let socket: WebSocket | null = null;
let reconnectTimeoutId: number | null = null;
let reconnectAttempt = 0;
let consecutiveConnectFailures = 0;
let authProbeInFlight = false;
const outboundQueue: RendererToMainMessage[] = [];
const sharedObjectSubscriptions = new SharedObjectSubscriptions();
const pendingInvokes = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: unknown) => void;
  }
>();
const pendingDirectoryEntries = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: WorkspaceDirectoryEntries) => void;
  }
>();
const rendererListeners = new Map<string, Set<IpcListener>>();
const messagePorts = new Map<string, MessagePort>();
const MESSAGE_FOR_VIEW_CHANNEL = "codex_desktop:message-for-view";
const AUTH_PROBE_FAILURE_INTERVAL = 5;
const DISCONNECT_ERROR_MESSAGE =
  "[electron-stub] IPC bridge disconnected before the response arrived; the connection is being retried";
let hasConnectedBefore = false;
let hasConnectionFailed = false;
let hasReconnected = false;
let connectionWatchdog: ConnectionWatchdog | null = null;
let reconnectRecoveryTimeoutId: number | null = null;
const reconnectRecovery = new ReconnectRecovery();
const rpcLifecycle = new RpcLifecycle(
  (event) => emitRendererEvent(MESSAGE_FOR_VIEW_CHANNEL, [event]),
  (id, error) => {
    const pending = pendingInvokes.get(id);
    pendingInvokes.delete(id);
    const queued = outboundQueue.findIndex(
      (message) =>
        message.type === "ipc-renderer-invoke" && message.requestId === id,
    );
    if (queued !== -1) outboundQueue.splice(queued, 1);
    if (error) pending?.reject(error);
    else pending?.resolve(undefined);
  },
);

function scheduleReconnectRecovery(): void {
  if (reconnectRecoveryTimeoutId !== null) {
    window.clearTimeout(reconnectRecoveryTimeoutId);
  }
  const expectedSocket = socket;
  reconnectRecoveryTimeoutId = window.setTimeout(() => {
    reconnectRecoveryTimeoutId = null;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      socket !== expectedSocket
    ) {
      return;
    }
    console.info(
      "[electron-stub] IPC bridge reconnected; triggering app-server recovery",
    );
    for (const event of reconnectRecovery.pending()) {
      emitRendererEvent(MESSAGE_FOR_VIEW_CHANNEL, [event]);
    }
  }, 2_000);
}

function unimplemented(method: string): never {
  debugger;
  throw new Error(`[electron-stub] ${method} is not implemented`);
}

export function emitRendererEvent(channel: string, args: unknown[]): void {
  const listeners = rendererListeners.get(channel);
  if (!listeners || listeners.size === 0) {
    return;
  }
  const event = { sender: null };
  for (const listener of listeners) {
    listener(event, ...args);
  }
}

function handleIncomingMessage(message: MainToRendererMessage): void {
  if (message.type === "bridge-pong") {
    connectionWatchdog?.pong(message.requestId);
    return;
  }
  if (message.type === "ipc-main-event") {
    if (message.channel === MESSAGE_FOR_VIEW_CHANNEL) {
      const payload = message.args[0];
      reconnectRecovery.observe(payload);
      if (
        hasReconnected &&
        isRecord(payload) &&
        payload.type === "codex-app-server-connection-changed" &&
        payload.state === "connected"
      )
        scheduleReconnectRecovery();
    }
    emitRendererEvent(message.channel, message.args);
    return;
  }

  if (message.type === "ipc-renderer-invoke-result") {
    if (
      !message.ok &&
      rpcLifecycle.fail(message.requestId, "Request delivery failed.")
    )
      return;
    const pending = pendingInvokes.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingInvokes.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
    return;
  }

  if (message.type === "message-port-message") {
    messagePorts.get(message.portId)?.postMessage(message.data);
    return;
  }

  if (message.type === "message-port-close") {
    const port = messagePorts.get(message.portId);
    messagePorts.delete(message.portId);
    port?.close();
    return;
  }

  if (message.type === "workspace-directory-entries-result") {
    const pending = pendingDirectoryEntries.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingDirectoryEntries.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
  }
}

function flushOutboundQueue(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  while (outboundQueue.length && socket?.readyState === WebSocket.OPEN) {
    const message = outboundQueue.shift()!;
    try {
      socket.send(JSON.stringify(message));
      if (message.type === "ipc-renderer-invoke")
        rpcLifecycle.sent(message.requestId);
    } catch {
      forceReconnect();
      return;
    }
  }
}

function failPendingRequests(reason: Error): void {
  hasConnectionFailed = true;
  const retained = outboundQueue.filter(
    (message) => message.type === "ipc-renderer-send",
  );
  outboundQueue.length = 0;
  outboundQueue.push(...retained);

  rpcLifecycle.disconnect();

  for (const pending of pendingInvokes.values()) {
    pending.reject(reason);
  }
  pendingInvokes.clear();
  for (const pending of pendingDirectoryEntries.values()) {
    pending.reject(reason);
  }
  pendingDirectoryEntries.clear();
}

function closeMessagePorts(): void {
  for (const port of messagePorts.values()) {
    port.close();
  }
  messagePorts.clear();
}

function scheduleReconnect(): void {
  if (reconnectTimeoutId !== null) {
    return;
  }
  const delay = reconnectDelayMs(reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimeoutId = window.setTimeout(() => {
    reconnectTimeoutId = null;
    ensureSocket();
  }, delay);
}

function reconnectNow(): void {
  if (reconnectTimeoutId !== null) {
    window.clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = null;
  }
  reconnectAttempt = 0;
  ensureSocket();
}

function forceReconnect(): void {
  const previousSocket = socket;
  if (previousSocket) {
    socket = null;
    connectionWatchdog?.stop();
    connectionWatchdog = null;
    closeMessagePorts();
    failPendingRequests(new Error(DISCONNECT_ERROR_MESSAGE));
    previousSocket.close();
  }
  reconnectNow();
}

function probeConnection(): void {
  rpcLifecycle.expire();
  if (connectionWatchdog && !connectionWatchdog.check()) return;
  reconnectNow();
  if (socket?.readyState !== WebSocket.OPEN) return;
  const currentSocket = socket;
  const requestId = nextRequestId();
  connectionWatchdog?.probe(requestId, () => {
    try {
      currentSocket.send(JSON.stringify({ type: "bridge-ping", requestId }));
    } catch {
      forceReconnect();
    }
  });
}

function maybeProbeAuthFailure(): void {
  if (
    consecutiveConnectFailures % AUTH_PROBE_FAILURE_INTERVAL !== 0 ||
    authProbeInFlight
  ) {
    return;
  }
  authProbeInFlight = true;
  void fetch("/", { method: "HEAD", cache: "no-store" })
    .then((response) => {
      if (response.status === 401) {
        clearStatsigSnapshots();
        console.error(
          "[electron-stub] IPC bridge auth rejected; reloading to show sign-in instructions",
        );
        window.location.reload();
      }
    })
    .catch(() => {})
    .finally(() => {
      authProbeInFlight = false;
    });
}

function ensureSocket(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const currentSocket = new WebSocket(
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/__backend/ipc`,
  );
  socket = currentSocket;
  connectionWatchdog = new ConnectionWatchdog(() => {
    if (socket !== currentSocket) return;
    forceReconnect();
  });
  let opened = false;

  currentSocket.addEventListener("open", () => {
    if (socket !== currentSocket) {
      return;
    }
    opened = true;
    connectionWatchdog?.opened();
    reconnectRecovery.begin();
    reconnectAttempt = 0;
    consecutiveConnectFailures = 0;
    // The server releases this socket's Desktop references on disconnect.
    // Replay before flushing new calls, so queued subscribes/unsubscribes retain
    // their normal ordering and responses. Replay replies need no JS promise.
    for (const [key, count] of sharedObjectSubscriptions.beforeQueued(
      outboundQueue,
    )) {
      for (let i = 0; i < count; i++) {
        currentSocket.send(
          JSON.stringify({
            type: "ipc-renderer-invoke",
            requestId: nextRequestId(),
            channel: SHARED_OBJECT_CHANNEL,
            args: [{ type: "shared-object-subscribe", key }],
          }),
        );
      }
    }
    flushOutboundQueue();
    if (socket !== currentSocket || currentSocket.readyState !== WebSocket.OPEN)
      return;
    if (hasConnectedBefore) {
      hasReconnected = true;
      // A host can reconnect while this tab is absent. Ask Desktop for its
      // current connection/initialization snapshots before replaying recovery.
      void invokeMain(SHARED_OBJECT_CHANNEL, [{ type: "ready" }]).catch(
        () => {},
      );
      scheduleReconnectRecovery();
    }
    hasConnectedBefore = true;
  });
  currentSocket.addEventListener("message", (event) => {
    if (socket !== currentSocket) {
      return;
    }
    try {
      const message = JSON.parse(String(event.data)) as MainToRendererMessage;
      handleIncomingMessage(message);
    } catch (error) {
      console.error(
        "[electron-stub] failed to parse IPC bridge message",
        error,
      );
    }
  });
  currentSocket.addEventListener("close", () => {
    if (socket !== currentSocket) {
      return;
    }
    socket = null;
    connectionWatchdog?.stop();
    connectionWatchdog = null;
    if (!opened) {
      consecutiveConnectFailures += 1;
      maybeProbeAuthFailure();
    }
    closeMessagePorts();
    failPendingRequests(new Error(DISCONNECT_ERROR_MESSAGE));
    scheduleReconnect();
  });
  currentSocket.addEventListener("error", () => {
    if (socket !== currentSocket) {
      return;
    }
    // A failed browser handshake may stay CONNECTING until its close callback.
    // The watchdog bounds it even when that callback never arrives.
    scheduleReconnect();
  });
}

function enqueueMessage(message: RendererToMainMessage): void {
  sharedObjectSubscriptions.track(message);
  outboundQueue.push(message);
  ensureSocket();
  flushOutboundQueue();
}

function nextRequestId(): string {
  requestCounter += 1;
  return `ipc_bridge_${requestCounter}`;
}

function invokeMain(channel: string, args: unknown[]): Promise<unknown> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingInvokes.set(requestId, { resolve, reject });
    const isRpc = rpcLifecycle.track(requestId, channel, args);
    if (isRpc && hasConnectionFailed && socket?.readyState !== WebSocket.OPEN) {
      rpcLifecycle.fail(
        requestId,
        "Connection is being restored. Please retry when connected.",
      );
      return;
    }
    enqueueMessage({
      type: "ipc-renderer-invoke",
      requestId,
      channel,
      args,
    });
  });
}

function addIpcListener(channel: string, listener: IpcListener): void {
  const listeners = rendererListeners.get(channel) ?? new Set<IpcListener>();
  listeners.add(listener);
  rendererListeners.set(channel, listeners);
}

function shouldCloseSidebarForMemoryPath(path: string): boolean {
  return (
    path === "/" ||
    path.startsWith("/local/") ||
    path === "/skills" ||
    path === "/automations"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnhandledAddWorkspaceRootOptionMessage(value: unknown): value is {
  root?: unknown;
  type: "electron-add-new-workspace-root-option";
} {
  return (
    isRecord(value) &&
    value.type === "electron-add-new-workspace-root-option" &&
    typeof value.root !== "string"
  );
}

function isPickWorkspaceRootOptionMessage(value: unknown): value is {
  allowMultiple?: unknown;
  type: "electron-pick-workspace-root-option";
} {
  return (
    isRecord(value) && value.type === "electron-pick-workspace-root-option"
  );
}

function isOpenInBrowserMessage(value: unknown): value is {
  type: "open-in-browser";
  url: string;
} {
  return (
    isRecord(value) &&
    value.type === "open-in-browser" &&
    typeof value.url === "string"
  );
}

function requestWorkspaceDirectoryEntries(
  directoryPath: string | null,
): Promise<WorkspaceDirectoryEntries> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingDirectoryEntries.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "workspace-directory-entries-request",
      requestId,
      directoryPath,
      directoriesOnly: true,
    });
  });
}

const themeMediaQuery = matchMedia("(prefers-color-scheme: dark)");
const mobileMediaQuery = matchMedia("(max-width: 768px)");
const initialSidebarState = !mobileMediaQuery.matches;
const electronShim = (window.__ELECTRON_SHIM__ ??= {});
electronShim.appServerRequestLifecycle = (event) =>
  rpcLifecycle.onLifecycle(event);
electronShim.isTransportFailure = isTransportFailure;
electronShim.imageDrafts = imageDrafts;
electronShim.wrapBrowserServices = wrapBrowserServices;
electronShim.downloadErrorMessage = downloadErrorMessage;
electronShim.configureStatsigClient = (client, sdkKey) =>
  configureStatsigClient(client, sdkKey, __CODEX_WEB_BUILD_ID__);
const buildFlavor: "prod" | "dev" | "agent" | string = "prod";

Object.assign(globalThis, {
  process: {
    arch: "arm64",
    platform: "darwin",
    versions: {
      electron: "41.2.0",
    },
  },
});

electronShim.overrideAdapter = desktopCapabilityOverrides;

const initialRoute = mapBrowserPathToInitialRoute(
  window.location.pathname,
  window.location.search,
);
electronShim.initialRoute = initialRoute.memoryPath;

if (initialRoute.browserPath) {
  window.history.pushState(undefined, "", initialRoute.browserPath);
}

electronShim.initialSidebarState = initialSidebarState;
electronShim.onMemoryNavigationChanged = (navigation) => {
  const path = navigation.location.pathname;
  if (
    navigation.action !== "POP" &&
    mobileMediaQuery.matches &&
    shouldCloseSidebarForMemoryPath(path)
  ) {
    electronShim.closeSidebar?.();
  }

  const browserPath = mapMemoryPathToBrowserPath(path);
  if (browserPath == null) {
    return;
  }

  if (browserPath.titleChange) {
    document.title = browserPath.titleChange;
  }

  if (window.location.pathname === browserPath.path) {
    window.history.replaceState(undefined, "", browserPath.path);
    return;
  }

  window.history.pushState(undefined, "", browserPath.path);
};

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (channel === "codex_desktop:message-from-view" && args.length === 1) {
      if (isOpenInBrowserMessage(args[0])) {
        window.open(args[0].url, "_blank", "noopener,noreferrer");
      }

      if (isLocalFilePickerMessage(args[0])) {
        return handleLocalFilePickerMessage(args[0]);
      }

      if (isUnhandledAddWorkspaceRootOptionMessage(args[0])) {
        return openSelectWorkspaceRootDialog({
          listDirectory: requestWorkspaceDirectoryEntries,
        }).then((root) => {
          if (!root) {
            return undefined;
          }

          return invokeMain(channel, [{ ...args[0], root }]);
        });
      }

      if (isPickWorkspaceRootOptionMessage(args[0])) {
        return openSelectWorkspaceRootDialog({
          listDirectory: requestWorkspaceDirectoryEntries,
        }).then((root) => {
          if (root) {
            emitRendererEvent(MESSAGE_FOR_VIEW_CHANNEL, [
              { type: "workspace-root-option-picked", root },
            ]);
          }
          return undefined;
        });
      }
    }

    return invokeMain(channel, args);
  },
  on(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  once(channel: string, listener: IpcListener): unknown {
    const wrapped: IpcListener = (event, ...args) => {
      this.removeListener(channel, wrapped);
      listener(event, ...args);
    };
    addIpcListener(channel, wrapped);
    return this;
  },
  addListener(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  removeListener(channel: string, listener: IpcListener): unknown {
    rendererListeners.get(channel)?.delete(listener);
    return this;
  },
  off(channel: string, listener: IpcListener): unknown {
    return this.removeListener(channel, listener);
  },
  send(channel: string, ...args: unknown[]): void {
    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args,
    });
  },
  postMessage(
    channel: string,
    message: unknown,
    transfer?: Transferable[],
  ): void {
    if (transfer && transfer.length > 0) {
      const portIds = transfer.map((transferable) => {
        if (!(transferable instanceof MessagePort)) {
          throw new TypeError(
            "Only MessagePort transfers are supported by the browser IPC bridge.",
          );
        }

        const portId = `message_port_${nextRequestId()}`;
        messagePorts.set(portId, transferable);
        transferable.addEventListener("message", (event) => {
          enqueueMessage({
            type: "message-port-message",
            portId,
            data: event.data,
          });
        });
        transferable.addEventListener("messageerror", () => {
          messagePorts.delete(portId);
          enqueueMessage({ type: "message-port-close", portId });
        });
        transferable.start();
        return portId;
      });

      enqueueMessage({
        type: "ipc-renderer-post-message",
        channel,
        message,
        portIds,
      });
      return;
    }

    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args: [message],
    });
  },
  sendSync(channel: string, ..._args: unknown[]): unknown {
    if (channel === "codex_desktop:get-sentry-init-options") {
      return {
        codexAppSessionId: "42626fde-7064-471f-b44d-b1a7ad849c7f",
        buildFlavor,
        buildNumber: null,
        appVersion: __CODEX_APP_VERSION__,
        enabled: false,
      };
    }

    if (channel === "codex_desktop:get-build-flavor") {
      return buildFlavor;
    }

    if (channel === "codex_desktop:get-uses-owl-app-shell") {
      return false;
    }

    if (channel === "codex_desktop:get-shared-object-snapshot") {
      return {
        host_config: { id: "local", display_name: "Local", kind: "local" },
        remote_ssh_connections: [],
        remote_wsl_connections: [],
        remote_control_connections_state: {
          available: false,
          accessRequired: false,
          authRequired: false,
          clientAuthorized: false,
        },
        local_remote_control_client_id: null,
        pending_worktrees: [],
      };
    }

    if (channel === "codex_desktop:get-initial-sidebar-bootstrap") {
      return null;
    }

    if (channel === "codex_desktop:get-system-theme-variant") {
      return themeMediaQuery.matches ? "dark" : "light";
    }

    return unimplemented("ipcRenderer.sendSync");
  },
};

ensureSocket();
installBrowserFileUploadBridge();
installMobileViewportGuard();

window.addEventListener("online", probeConnection);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) probeConnection();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    probeConnection();
  }
});

export const contextBridge = {
  exposeInMainWorld(_key: string, _api: unknown): void {
    Reflect.set(window, _key, adaptDesktopBridge(_key, _api));
  },
};

export const webUtils = {
  getPathForFile(file: File): string | null {
    return getUploadedFilePath(file);
  },
};
