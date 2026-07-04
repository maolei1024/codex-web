import { emitRendererEvent, isRecord } from "./shim";
import { shouldHandleFileEventTarget } from "./file-event-target";
import {
  getUploadedFilePath,
  rememberUploadedFilePaths,
} from "./uploaded-file-paths";

type CodexFetchMessage = {
  body?: string;
  headers?: Record<string, string>;
  hostId?: string;
  method: string;
  requestId: string;
  type: "fetch";
  url: string;
};

type PickFilesRequest = {
  imagesOnly?: boolean;
  pickerTitle?: string;
};

type UploadedFile = {
  label?: string;
  path?: string;
  fsPath?: string;
};

const replayedFileEvent = Symbol("codex-web-replayed-file-event");
let fileUploadBridgeInstalled = false;

const UPLOAD_ATTEMPTS = 2;
const UPLOAD_RETRY_DELAY_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openBrowserFilePicker({
  allowMultiple,
  imagesOnly,
}: {
  allowMultiple: boolean;
  imagesOnly?: boolean;
}): Promise<File[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    let settled = false;

    function cleanup(): void {
      input.removeEventListener("cancel", handleCancel);
      input.removeEventListener("change", handleChange);
      input.remove();
    }

    function finish(files: File[]): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(files);
    }

    function fail(error: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    }

    function handleCancel(): void {
      finish([]);
    }

    function handleChange(): void {
      finish(Array.from(input.files ?? []));
    }

    input.type = "file";
    input.multiple = allowMultiple;
    if (imagesOnly) {
      input.accept = "image/*";
    }
    Object.assign(input.style, {
      height: "1px",
      left: "-9999px",
      opacity: "0",
      position: "fixed",
      top: "0",
      width: "1px",
    });
    input.addEventListener("cancel", handleCancel);
    input.addEventListener("change", handleChange);
    document.body.append(input);

    try {
      input.click();
    } catch (error) {
      fail(error);
    }
  });
}

async function uploadFiles(files: readonly File[]): Promise<UploadedFile[]> {
  if (files.length === 0) {
    return [];
  }

  const uploadUrl = new URL("/__backend/upload", window.location.href);
  const formData = new FormData();

  for (const file of files) {
    formData.append("files", file, file.name || "upload");
  }

  // Retry only network-level failures; HTTP error statuses (401, 413, 500)
  // are deliberate server answers and are never retried.
  let lastError: unknown = new Error("upload failed");
  for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await delay(UPLOAD_RETRY_DELAY_MS);
    }

    let response: Response;
    try {
      response = await fetch(uploadUrl, {
        method: "POST",
        body: formData,
      });
    } catch (error) {
      lastError = error;
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `Upload failed: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()).files;
  }

  throw lastError;
}

export function installBrowserFileUploadBridge(): void {
  if (fileUploadBridgeInstalled || typeof window === "undefined") {
    return;
  }

  if (typeof DataTransfer !== "function") {
    return;
  }

  fileUploadBridgeInstalled = true;
  window.addEventListener("paste", handlePasteWithFiles, true);
  window.addEventListener("drop", handleDropWithFiles, true);
}

function handlePasteWithFiles(event: ClipboardEvent): void {
  interceptFileEvent(
    event,
    event.clipboardData,
    (dataTransfer) =>
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
        composed: true,
      }),
  );
}

function handleDropWithFiles(event: DragEvent): void {
  interceptFileEvent(
    event,
    event.dataTransfer,
    (dataTransfer) =>
      new DragEvent("drop", {
        altKey: event.altKey,
        bubbles: true,
        button: event.button,
        buttons: event.buttons,
        cancelable: true,
        clientX: event.clientX,
        clientY: event.clientY,
        composed: true,
        ctrlKey: event.ctrlKey,
        dataTransfer,
        metaKey: event.metaKey,
        screenX: event.screenX,
        screenY: event.screenY,
        shiftKey: event.shiftKey,
      }),
  );
}

function interceptFileEvent(
  event: ClipboardEvent | DragEvent,
  dataTransfer: DataTransfer | null,
  createReplayEvent: (dataTransfer: DataTransfer) => ClipboardEvent | DragEvent,
): void {
  if (isReplayedFileEvent(event)) {
    return;
  }

  if (!shouldHandleFileEventTarget(event.target)) {
    return;
  }

  const files = filesFromDataTransfer(dataTransfer);
  const filesToUpload = files.filter(
    (file) => getUploadedFilePath(file) == null,
  );

  if (filesToUpload.length === 0) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();

  const target = event.target;
  if (!(target instanceof EventTarget)) {
    return;
  }

  void (async () => {
    const uploadedFiles = await uploadFiles(filesToUpload);
    rememberUploadedFilePaths(filesToUpload, uploadedFiles);

    const replayDataTransfer = cloneDataTransfer(dataTransfer, files);
    target.dispatchEvent(markAsReplayed(createReplayEvent(replayDataTransfer)));
  })().catch((error) => {
    console.error("Failed to upload pasted or dropped files", error);
  });
}

function filesFromDataTransfer(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) {
    return [];
  }

  if (dataTransfer.files.length > 0) {
    return Array.from(dataTransfer.files);
  }

  return Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file != null);
}

function cloneDataTransfer(
  source: DataTransfer | null,
  files: readonly File[],
): DataTransfer {
  const clone = new DataTransfer();

  for (const file of files) {
    clone.items.add(file);
  }

  if (source) {
    for (const type of Array.from(source.types)) {
      if (type === "Files") {
        continue;
      }

      const value = source.getData(type);
      if (value) {
        clone.setData(type, value);
      }
    }
  }

  return clone;
}

function isReplayedFileEvent(event: Event): boolean {
  return (
    (event as Event & { [replayedFileEvent]?: true })[replayedFileEvent] ===
    true
  );
}

function markAsReplayed<T extends Event>(event: T): T {
  Object.defineProperty(event, replayedFileEvent, {
    value: true,
  });
  return event;
}

export async function handleLocalFilePickerMessage(message: CodexFetchMessage) {
  try {
    const response = await handleLocalFilePickerMessageInner(message);

    sendFetchResponse(message, {
      responseType: "success",
      body: response,
    });
  } catch (error) {
    console.error(error);

    sendFetchResponse(message, {
      responseType: "error",
      status: 432,
      error: errorMessage(error),
    });
  }
}

async function handleLocalFilePickerMessageInner(message: CodexFetchMessage) {
  const request = parsePickFilesRequest(message);
  const allowMultiple = message.url === "vscode://codex/pick-files";

  const selectedFiles = await openBrowserFilePicker({
    allowMultiple,
    imagesOnly: request.imagesOnly,
  });

  const uploadedFiles = await uploadFiles(selectedFiles);
  rememberUploadedFilePaths(selectedFiles, uploadedFiles);

  return allowMultiple
    ? { files: uploadedFiles }
    : { file: uploadedFiles[0] ?? null };
}

function isCodexFetchMessage(value: unknown): value is CodexFetchMessage {
  return isRecord(value) && value.type === "fetch";
}

export function isLocalFilePickerMessage(
  value: unknown,
): value is CodexFetchMessage {
  return (
    isCodexFetchMessage(value) &&
    value.method.toUpperCase() === "POST" &&
    (value.url === "vscode://codex/pick-files" ||
      value.url === "vscode://codex/pick-file")
  );
}

function parsePickFilesRequest(message: CodexFetchMessage): PickFilesRequest {
  if (!message.body) {
    return {};
  }

  try {
    const parsed = JSON.parse(message.body) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return {
      imagesOnly:
        typeof parsed.imagesOnly === "boolean" ? parsed.imagesOnly : undefined,
      pickerTitle:
        typeof parsed.pickerTitle === "string" ? parsed.pickerTitle : undefined,
    };
  } catch {
    return {};
  }
}

function sendFetchResponse(
  message: CodexFetchMessage,
  response:
    | {
        responseType: "success";
        body: unknown;
        status?: number;
      }
    | {
        responseType: "error";
        error: string;
        status?: number;
      },
): void {
  const payload =
    response.responseType === "success"
      ? {
          type: "fetch-response",
          responseType: "success",
          requestId: message.requestId,
          status: response.status ?? 200,
          headers: { "content-type": "application/json" },
          bodyJsonString: JSON.stringify(response.body),
        }
      : {
          type: "fetch-response",
          responseType: "error",
          requestId: message.requestId,
          status: response.status ?? 432,
          error: response.error,
        };

  emitRendererEvent("codex_desktop:message-for-view", [payload]);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
