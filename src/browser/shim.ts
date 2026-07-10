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
import { installMobileViewportGuard } from "./mobile-viewport";
import { reconnectDelayMs } from "./reconnect";

import {
  installWorkspaceRootDialog,
  openSelectWorkspaceRootDialog,
  type WorkspaceDirectoryEntries,
} from "./workspace-root-dialog";

type IpcListener = (event: unknown, ...args: unknown[]) => void;

// The upstream preload runs inside Electron where `process` is available and
// reads process.platform/arch (e.g. isIntelMacBuild). Provide a minimal stand-in
// before any of that code executes in the browser.
const globalWithProcess = globalThis as typeof globalThis & {
  process?: {
    platform?: string;
    arch?: string;
    env?: Record<string, string | undefined>;
  };
};
if (globalWithProcess.process == null) {
  globalWithProcess.process = { platform: "linux", arch: "x64", env: {} };
}

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
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

const CLIENT_STALE_TIMEOUT_MS = 45_000;
const STALENESS_CHECK_INTERVAL_MS = 10_000;
const AUTH_PROBE_FAILURE_INTERVAL = 5;
const DISCONNECT_ERROR_MESSAGE =
  "[electron-stub] IPC bridge disconnected before the response arrived; the connection is being retried";

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
  initialRoute?: string;
  initialSidebarState?: boolean;
  closeSidebar?: () => void;
  onMemoryNavigationChanged?: (navigation: MemoryNavigationChange) => void;
  overrideAdapter?: {
    getGateOverride?: (
      e: StatsigGateEvaluation,
      ...args: unknown[]
    ) => StatsigGateEvaluation | null;
  };
};

type StatsigGateEvaluation = {
  name: string;
  value: boolean;
  [key: string]: unknown;
};

declare global {
  interface Window {
    __ELECTRON_SHIM__?: ElectronShimState;
  }
}

declare const __CODEX_APP_VERSION__: string;

let requestCounter = 0;
let socket: WebSocket | null = null;
let reconnectTimeoutId: number | null = null;
let reconnectAttempt = 0;
let lastMessageAtMs = Date.now();
let consecutiveConnectFailures = 0;
let authProbeInFlight = false;
const outboundQueue: RendererToMainMessage[] = [];
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
const bridgedPorts = new Map<string, MessagePort>();

const MESSAGE_FOR_VIEW_CHANNEL = "codex_desktop:message-for-view";
// Broadcast events missed while the WebSocket was down (turn/completed,
// thread/status/changed, ...) are never replayed by the server, and the
// upstream reconnect-recovery machinery only listens to app-server transport
// events — it knows nothing about our browser<->server link. Synthesizing
// codex-app-server-initialized after a reconnect drives the upstream
// app_server_restart_recovery path: query invalidation, an authoritative
// thread/list refresh, mark-all-conversations-need-resume and a resume of the
// currently open conversation. Prefer replaying the last genuine payload when
// one was observed (server restart while the page was open); otherwise fall
// back to values matching the deployed codex-cli.
let hasConnectedBefore = false;
let reconnectRecoveryTimeoutId: number | null = null;
let cachedAppServerInitializedMessage: Record<string, unknown> = {
  type: "codex-app-server-initialized",
  hostId: "local",
  appServerVersion: "0.144.1",
  installedCodexVersion: "0.144.1",
};

function scheduleReconnectRecovery(): void {
  if (reconnectRecoveryTimeoutId !== null) {
    window.clearTimeout(reconnectRecoveryTimeoutId);
  }
  reconnectRecoveryTimeoutId = window.setTimeout(() => {
    reconnectRecoveryTimeoutId = null;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    console.info(
      "[electron-stub] IPC bridge reconnected; triggering app-server recovery",
    );
    emitRendererEvent(MESSAGE_FOR_VIEW_CHANNEL, [
      cachedAppServerInitializedMessage,
    ]);
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
  if (message.type === "ping") {
    return;
  }

  if (message.type === "ipc-main-event") {
    if (message.channel === MESSAGE_FOR_VIEW_CHANNEL) {
      const payload = message.args[0];
      if (
        isRecord(payload) &&
        payload.type === "codex-app-server-initialized" &&
        payload.hostId === "local"
      ) {
        cachedAppServerInitializedMessage = payload;
      }
    }
    emitRendererEvent(message.channel, message.args);
    return;
  }

  if (message.type === "app-host-port-message") {
    bridgedPorts.get(message.portId)?.postMessage(message.data);
    return;
  }

  if (message.type === "app-host-port-close") {
    const port = bridgedPorts.get(message.portId);
    bridgedPorts.delete(message.portId);
    port?.close();
    return;
  }

  if (message.type === "ipc-renderer-invoke-result") {
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
  for (const message of outboundQueue.splice(0)) {
    socket.send(JSON.stringify(message));
  }
}

function failPendingRequests(reason: Error): void {
  const retained = outboundQueue.filter(
    (message) =>
      message.type === "ipc-renderer-send" ||
      message.type === "app-host-port-connect" ||
      message.type === "app-host-port-message" ||
      message.type === "app-host-port-close",
  );
  outboundQueue.length = 0;
  outboundQueue.push(...retained);

  for (const pending of pendingInvokes.values()) {
    pending.reject(reason);
  }
  pendingInvokes.clear();
  for (const pending of pendingDirectoryEntries.values()) {
    pending.reject(reason);
  }
  pendingDirectoryEntries.clear();
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

function maybeProbeAuthFailure(): void {
  if (consecutiveConnectFailures % AUTH_PROBE_FAILURE_INTERVAL !== 0) {
    return;
  }
  if (authProbeInFlight) {
    return;
  }
  authProbeInFlight = true;
  void fetch("/", { method: "HEAD", cache: "no-store" })
    .then((response) => {
      if (response.status === 401) {
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
  let opened = false;

  currentSocket.addEventListener("open", () => {
    if (socket !== currentSocket) {
      return;
    }
    opened = true;
    reconnectAttempt = 0;
    consecutiveConnectFailures = 0;
    lastMessageAtMs = Date.now();
    flushOutboundQueue();
    if (hasConnectedBefore) {
      scheduleReconnectRecovery();
    }
    hasConnectedBefore = true;
  });
  currentSocket.addEventListener("message", (event) => {
    if (socket !== currentSocket) {
      return;
    }
    lastMessageAtMs = Date.now();
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
    if (!opened) {
      consecutiveConnectFailures += 1;
      maybeProbeAuthFailure();
    }
    failPendingRequests(new Error(DISCONNECT_ERROR_MESSAGE));
    scheduleReconnect();
  });
  currentSocket.addEventListener("error", () => {
    if (socket !== currentSocket) {
      return;
    }
    scheduleReconnect();
  });
}

function enqueueMessage(message: RendererToMainMessage): void {
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

// 26.623's Create-project modal and onboarding flow ask the Electron main
// process to open a native directory picker (dialog.showOpenDialog) via this
// message; the pickers reply with a workspace-root-option-picked view message
// per selected directory. In the browser we substitute our own host-directory
// dialog and synthesize the reply locally.
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

electronShim.overrideAdapter = {
  getGateOverride(e) {
    if (e.name === "2929582856") {
      // codex_app_sunset
      return {
        ...e,
        value: false,
      };
    }

    return null;
  },
};

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

const buildFlavor: "prod" | "dev" | "agent" | string = "prod";

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
    _message: unknown,
    transfer?: MessagePort[],
  ): void {
    // Bridge the transferred MessagePort over the WebSocket: frames from the
    // page are forwarded as app-host-port-message, and the server side hands
    // a fake MessagePortMain to the upstream ipcMain listener.
    const port = transfer?.[0];
    if (!port) {
      return;
    }
    requestCounter += 1;
    const portId = `port-${requestCounter}-${Math.random().toString(36).slice(2)}`;
    bridgedPorts.set(portId, port);
    port.onmessage = (event: MessageEvent) => {
      enqueueMessage({
        type: "app-host-port-message",
        portId,
        data: event.data,
      });
    };
    port.start();
    enqueueMessage({ type: "app-host-port-connect", portId, channel });
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
        host_config: {
          id: "local",
          display_name: "Local",
          kind: "local",
        },
        remote_connections: [],
        remote_control_connections: [],
        remote_control_connections_state: {
          available: false,
          authRequired: false,
        },
        pending_worktrees: [],
        statsig_default_enable_features: {
          enable_request_compression: true,
          collaboration_modes: true,
          personality: true,
          request_rule: true,
          fast_mode: true,
          image_generation: true,
          image_detail_original: true,
          workspace_dependencies: true,
          guardian_approval: true,
          apps: true,
          plugins: true,
          tool_search: true,
          tool_suggest: false,
          tool_call_mcp_elicitation: true,
          memories: false,
          realtime_conversation: false,
        },
      };
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

window.setInterval(() => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  if (Date.now() - lastMessageAtMs <= CLIENT_STALE_TIMEOUT_MS) {
    return;
  }
  console.warn("[electron-stub] IPC bridge connection stale; forcing reconnect");
  const staleSocket = socket;
  socket = null;
  staleSocket.close();
  failPendingRequests(
    new Error(
      "[electron-stub] IPC bridge connection went stale; the connection is being retried",
    ),
  );
  scheduleReconnect();
}, STALENESS_CHECK_INTERVAL_MS);

window.addEventListener("online", reconnectNow);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    reconnectNow();
  }
});

export const contextBridge = {
  exposeInMainWorld(_key: string, _api: unknown): void {
    Reflect.set(window, _key, _api);
  },
};

export const webUtils = {
  getPathForFile(file: File): string | null {
    return getUploadedFilePath(file);
  },
};
