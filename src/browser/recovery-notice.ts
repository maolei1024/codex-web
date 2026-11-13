/** Outside the React tree: recovery never unmounts the editor or its attachments. */
export async function checkForUpdate(buildId: string) {
  try {
    const response = await fetch("/__backend/version", {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return;
    const version = await response.json();
    if (
      !version.buildId ||
      version.buildId === buildId ||
      document.getElementById("codex-web-update")
    )
      return;
    const notice = document.createElement("div");
    notice.id = "codex-web-update";
    notice.setAttribute("role", "status");
    notice.textContent = navigator.language.startsWith("zh")
      ? "新版已发布。请先保留草稿和附件，再自行刷新此页面。"
      : "An update is available. Keep your draft and attachments, then refresh when ready.";
    notice.style.cssText =
      "position:fixed;bottom:12px;left:12px;z-index:2147483646;max-width:90vw;padding:12px 16px;border-radius:10px;background:#292524;color:white;font:14px system-ui";
    const dismiss = document.createElement("button");
    dismiss.textContent = navigator.language.startsWith("zh")
      ? "稍后"
      : "Later";
    dismiss.style.cssText = "margin-left:12px;cursor:pointer";
    dismiss.onclick = () => notice.remove();
    notice.append(dismiss);
    document.body.append(notice);
  } catch {
    /* Version discovery is not required configuration. */
  }
}

export function recoveryNotice(
  state: string,
  method: string,
  retry: () => void,
  exportDiagnostics?: () => void,
) {
  const id = "codex-web-recovery";
  let notice = document.getElementById(id);
  if (state === "connected") {
    notice?.remove();
    return;
  }
  if (!document.body) return;
  if (!notice) {
    notice = document.createElement("div");
    notice.id = id;
    notice.style.cssText =
      "position:fixed;top:max(12px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);z-index:2147483646;box-sizing:border-box;width:max-content;max-width:min(560px,calc(100vw - 24px - env(safe-area-inset-left) - env(safe-area-inset-right)));padding:12px 16px;border-radius:10px;background:#292524;color:#fff;font:16px/1.5 system-ui;box-shadow:0 3px 18px #0004;overflow-wrap:anywhere";
    const message = document.createElement("div");
    message.dataset.recoveryMessage = "";
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    message.setAttribute("aria-atomic", "true");
    const controls = document.createElement("div");
    controls.dataset.recoveryControls = "";
    controls.style.cssText =
      "display:flex;flex-wrap:wrap;gap:8px;margin-top:8px";
    notice.append(message, controls);
    document.body.append(notice);
  }
  const zh = /^zh(?:-|$)/i.test(
    document.documentElement.lang || navigator.language,
  );
  const copy = (a: string, b: string) => (zh ? a : b);
  const authentication = state === "failed" && method === "authentication";
  const waiting = state === "waiting-network";
  const paused = state === "paused";
  const busy = state !== "failed" && !waiting;
  const message = notice.querySelector<HTMLElement>("[data-recovery-message]")!;
  const controls = notice.querySelector<HTMLElement>(
    "[data-recovery-controls]",
  )!;
  message.textContent = authentication
    ? copy(
        "登录已失效，请保留草稿后重新认证。",
        "Sign-in expired. Keep your draft before signing in again.",
      )
    : state === "failed"
      ? copy(
          "暂时无法恢复连接。网络恢复后，请重连；当前内容和草稿仍保留。",
          "The connection could not be restored. Reconnect when your network is available. Content and drafts are still here.",
        )
      : waiting
        ? copy(
            "网络似乎已断开，正在等待恢复。当前内容和草稿仍保留。",
            "Your network appears to be offline. Waiting for it to return. Content and drafts are still here.",
          )
        : paused
          ? copy(
              "连接恢复已暂停，返回页面后继续。当前内容和草稿仍保留。",
              "Connection recovery is paused until you return. Content and drafts are still here.",
            )
          : copy(
              "正在恢复连接，请稍候。当前内容和草稿仍保留。",
              "Restoring connection. Please wait. Content and drafts are still here.",
            );

  let button = controls.querySelector<HTMLButtonElement>(
    "[data-recovery-retry]",
  );
  if (authentication) button?.remove();
  else {
    if (!button) {
      button = recoveryButton(document);
      button.dataset.recoveryRetry = "";
      controls.prepend(button);
    }
    button.disabled = busy;
    button.style.opacity = busy ? "0.65" : "1";
    button.style.cursor = busy ? "default" : "pointer";
    button.textContent = busy
      ? paused
        ? copy("已暂停", "Paused")
        : copy("正在重连…", "Reconnecting…")
      : copy("重连", "Reconnect");
    button.onclick = () => {
      if (button!.disabled) return;
      // Update synchronously so repeated taps cannot start parallel attempts.
      recoveryNotice("connecting", "", retry, exportDiagnostics);
      try {
        retry();
      } catch {
        recoveryNotice("failed", "", retry, exportDiagnostics);
      }
    };
  }

  let download = controls.querySelector<HTMLButtonElement>(
    "[data-recovery-export]",
  );
  if (!exportDiagnostics) download?.remove();
  else {
    if (!download) {
      download = recoveryButton(document);
      download.dataset.recoveryExport = "";
      controls.append(download);
    }
    download.textContent = copy("导出诊断", "Export diagnostics");
    download.title = copy(
      "下载此页面的连接状态，不含对话正文、草稿或凭据；无需网络。",
      "Download this page's connection state, without conversation content, drafts or credentials. No network required.",
    );
    download.onclick = () => {
      try {
        // Keep the browser user gesture for downloads on mobile.
        exportDiagnostics();
      } catch {
        message.textContent = copy(
          "未能下载诊断文件，请再次点击导出。当前内容和草稿仍保留。",
          "The diagnostic file could not be downloaded. Try exporting again. Content and drafts are still here.",
        );
      }
    };
  }
}

function recoveryButton(document: Document) {
  const button = document.createElement("button");
  button.type = "button";
  button.style.cssText =
    "min-height:44px;max-width:100%;padding:6px 12px;border:1px solid currentColor;border-radius:5px;background:transparent;color:inherit;font:inherit;cursor:pointer;outline-offset:3px;white-space:normal";
  return button;
}
