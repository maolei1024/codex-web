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
    notice.setAttribute("role", "status");
    notice.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483646;max-width:90vw;padding:12px 16px;border-radius:10px;background:#292524;color:#fff;font:14px system-ui;box-shadow:0 3px 18px #0004";
    document.body.append(notice);
  }
  const zh = navigator.language.startsWith("zh");
  notice.textContent =
    state === "failed"
      ? zh
        ? (method === "authentication"
            ? "登录已失效，请保留草稿后重新认证。"
            : method.includes("settings")
              ? "设置读取超时或失败，页面尚未就绪。"
              : "连接恢复失败，请检查服务或远程主机。") +
          "当前内容和草稿仍保留。"
        : method === "authentication"
          ? "Sign-in expired. Keep your draft before signing in again."
          : "Could not restore the connection or required settings. Content and drafts are still here."
      : zh
        ? "正在恢复连接，当前内容和草稿仍保留…"
        : "Restoring connection. Content and drafts are still here…";
  if (state === "failed") {
    const button = document.createElement("button");
    button.textContent = zh ? "重试" : "Retry";
    button.style.cssText =
      "margin-left:12px;padding:4px 10px;border:1px solid currentColor;border-radius:5px;cursor:pointer";
    button.onclick = retry;
    notice.append(button);
  }
}
