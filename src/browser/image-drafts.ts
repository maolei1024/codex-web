/** Browser-owned image drafts. No dependency on temporary server upload paths. */
export type DraftImage = {
  id: string;
  src: string;
  filename?: string;
  previewSrc?: string;
  uploadSrc?: string;
  uploadStatus?: string;
  localPath?: string;
};

export type ImageDraftStorage = {
  read(key: string): Promise<unknown>;
  write(key: string, images: DraftImage[]): Promise<void>;
};

// Keep the original pixels, not blob URLs, expiring upload paths or cloud IDs.
// Desktop can send inline images locally/remotely and re-upload them for Cloud.
export function durableImages(value: unknown): DraftImage[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((image) => {
    if (!image || typeof image.id !== "string" || seen.has(image.id)) return [];
    const src = [image.uploadSrc, image.src, image.previewSrc].find(
      (src) =>
        typeof src === "string" &&
        /^data:image\/[a-z0-9.+-]+;base64,/i.test(src),
    );
    if (!src) return [];
    seen.add(image.id);
    return [
      {
        id: image.id,
        src,
        ...(typeof image.filename === "string"
          ? { filename: image.filename }
          : {}),
        uploadStatus: "idle",
      },
    ];
  });
}

export function indexedDBImageDraftStorage(
  factory: () => IDBFactory = () => window.indexedDB,
): ImageDraftStorage {
  let opening: Promise<IDBDatabase> | undefined;
  function open(): Promise<IDBDatabase> {
    return (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory().open("codex-web-image-drafts", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("drafts");
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error("Image draft storage is blocked"));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opening = undefined;
        };
        resolve(db);
      };
    }).catch((error) => {
      opening = undefined;
      throw error;
    }));
  }
  async function transaction(
    key: string,
    images?: DraftImage[],
  ): Promise<unknown> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("drafts", images ? "readwrite" : "readonly");
      const store = tx.objectStore("drafts");
      const request = images
        ? images.length
          ? store.put(images, key)
          : store.delete(key)
        : store.get(key);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () =>
        reject(tx.error ?? new Error("Image draft transaction aborted"));
      tx.onerror = () => {}; // onabort reports failed transactions, not just requests.
    });
  }
  return {
    read: (key) => transaction(key),
    write: async (key, images) => {
      await transaction(key, images);
    },
  };
}

export function createImageDrafts(
  storage: ImageDraftStorage,
  onError: () => void = () => {},
) {
  const revisions = new Map<string, number>();
  const writes = new Map<string, Promise<void>>();
  return {
    save(key: string, images: DraftImage[]): Promise<void> {
      revisions.set(key, (revisions.get(key) ?? 0) + 1);
      const snapshot = durableImages(images);
      // Serialize per composer so a slow older save cannot resurrect a deletion.
      const pending = (writes.get(key) ?? Promise.resolve()).then(async () => {
        try {
          await storage.write(key, snapshot);
        } catch {
          // A quota failure must not leave an older, removed attachment as a draft.
          await storage.write(key, []).catch(() => {});
          onError();
        }
      });
      writes.set(key, pending);
      void pending.finally(() => {
        if (writes.get(key) === pending) writes.delete(key);
      });
      return pending;
    },
    mount(
      key: string,
      current: () => DraftImage[],
      restore: (images: DraftImage[]) => void,
    ) {
      let disposed = false;
      const revision = revisions.get(key) ?? 0;
      void (async () => {
        await writes.get(key);
        const images = durableImages(await storage.read(key));
        // Never replace newly added images, undo a send/clear, or revive an old route.
        if (
          !disposed &&
          revision === (revisions.get(key) ?? 0) &&
          images.length &&
          current().length === 0
        )
          restore(images);
      })().catch(onError);
      return () => {
        disposed = true;
      };
    },
  };
}

function showDraftStorageError(): void {
  if (document.getElementById("codex-web-image-draft-error")) return;
  const notice = document.createElement("div");
  notice.id = "codex-web-image-draft-error";
  notice.setAttribute("role", "alert");
  notice.textContent = navigator.language.startsWith("zh")
    ? "图片草稿无法保存或恢复。刷新前请保留原图。"
    : "Image drafts could not be saved or restored. Keep the original images before refreshing.";
  Object.assign(notice.style, {
    position: "fixed",
    bottom: "16px",
    left: "16px",
    right: "16px",
    zIndex: "2147483647",
    padding: "12px",
    borderRadius: "8px",
    background: "#78350f",
    color: "white",
    font: "14px system-ui",
  });
  const close = document.createElement("button");
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss");
  close.style.cssText = "float:right;margin-left:12px;font-size:20px";
  close.onclick = () => notice.remove();
  notice.append(close);
  document.body.append(notice);
}

export const imageDrafts = createImageDrafts(
  indexedDBImageDraftStorage(),
  showDraftStorageError,
);
