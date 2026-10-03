/** Browser permission and playback controls beside the existing Desktop settings. */
export type NotificationSound = string | { fileName: string; name?: string };

export type NotificationSettingsState = {
  supported: boolean;
  permission: string;
  audioState: "locked" | "ready" | "unavailable";
  volume: number;
  dedupAvailable: boolean;
  error?: string;
};

export type NotificationSettingsController = {
  getState(): NotificationSettingsState;
  subscribe(listener: () => void): () => void;
  requestPermission(): Promise<string>;
  unlockAudio(): Promise<boolean>;
  preview(sound: NotificationSound): Promise<boolean>;
  setVolume(volume: number): void;
};

let settingsInstance = 0;

export function mountNotificationSettings(
  element: HTMLElement,
  controller: NotificationSettingsController,
  getSound: () => NotificationSound = () => "default",
  locale?: string,
): () => void {
  const document = element.ownerDocument;
  const chinese = /^zh(?:-|$)/i.test(
    locale ||
      document.documentElement.lang ||
      document.defaultView?.navigator.language ||
      "en",
  );
  const copy = (zh: string, en: string) => (chinese ? zh : en);
  const root = document.createElement("div");
  const id = `codex-web-notification-settings-${++settingsInstance}`;
  let disposed = false;
  let requesting = false;
  let previewing = false;
  let actionError = "";

  function row(label: string, suffix: string) {
    const container = document.createElement("div");
    container.className =
      "@container/settings-row px-4 flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6";
    const text = document.createElement("div");
    text.className = "flex min-w-0 flex-1 flex-col gap-1";
    const title = document.createElement("label");
    title.className = "text-sm font-medium text-default";
    title.id = `${id}-${suffix}-label`;
    title.textContent = label;
    const description = document.createElement("div");
    description.className = "text-sm text-secondary";
    description.id = `${id}-${suffix}-description`;
    const controls = document.createElement("div");
    controls.className =
      "flex max-w-full shrink-0 items-center justify-end gap-2";
    text.append(title, description);
    container.append(text, controls);
    root.append(container);
    return { title, description, controls };
  }

  function button(target: ReturnType<typeof row>, action: () => Promise<void>) {
    const control = document.createElement("button");
    control.type = "button";
    control.id = `${target.title.id}-control`;
    control.className =
      "rounded-lg px-3 text-sm font-medium text-default ring-[0.5px] ring-token-border enabled:hover:bg-token-list-hover-background disabled:cursor-default disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
    control.style.minHeight = "44px";
    control.setAttribute("aria-describedby", target.description.id);
    target.title.htmlFor = control.id;
    control.addEventListener("click", () => void action());
    target.controls.append(control);
    return control;
  }

  const permissionRow = row(
    copy("通知权限", "Notification permission"),
    "permission",
  );
  const permissionButton = button(permissionRow, async () => {
    if (requesting || disposed) return;
    requesting = true;
    actionError = "";
    render();
    try {
      await controller.requestPermission();
    } catch {
      actionError = copy(
        "无法申请通知权限。请检查浏览器的站点设置。",
        "Could not request permission. Check this site's browser settings.",
      );
    } finally {
      requesting = false;
      render();
    }
  });

  const soundRow = row(copy("声音播放", "Sound playback"), "sound");
  const previewButton = button(soundRow, async () => {
    if (previewing || disposed) return;
    const sound = getSound();
    if (sound === "none") {
      actionError = copy(
        "请先将完成提示音设为默认或经典。",
        "Choose Default or Classic completion sound before testing.",
      );
      render();
      return;
    }
    // This call resumes the persistent AudioContext in the click's user gesture.
    const unlocked = controller.unlockAudio();
    previewing = true;
    actionError = "";
    render();
    try {
      if (!(await unlocked) || !(await controller.preview(sound))) {
        actionError = copy(
          "未能播放声音。请检查浏览器声音设置后再次试听。",
          "Could not play the sound. Check browser sound settings and try again.",
        );
      }
    } catch {
      actionError = copy(
        "未能播放声音。请再次试听。",
        "Could not play the sound. Try again.",
      );
    } finally {
      previewing = false;
      render();
    }
  });

  const volumeRow = row(copy("提示音音量", "Sound volume"), "volume");
  volumeRow.description.textContent = copy(
    "只保存在当前浏览器和站点。",
    "Saved only in this browser for this site.",
  );
  const volume = document.createElement("input");
  volume.type = "range";
  volume.min = "0";
  volume.max = "100";
  volume.step = "1";
  volume.id = `${id}-volume-control`;
  volume.className = "accent-current cursor-pointer";
  // Desktop resets every input to appearance:none; keep the browser's range
  // track and thumb, which accent-color then themes with the existing text.
  volume.style.appearance = "auto";
  volume.style.setProperty("-webkit-appearance", "auto");
  volume.style.width = "min(32vw, 160px)";
  volume.style.minWidth = "96px";
  volume.style.minHeight = "44px";
  volume.setAttribute("aria-labelledby", volumeRow.title.id);
  volume.setAttribute("aria-describedby", volumeRow.description.id);
  volumeRow.title.htmlFor = volume.id;
  const volumeValue = document.createElement("output");
  volumeValue.htmlFor = volume.id;
  volumeValue.className = "text-sm text-secondary tabular-nums";
  volumeValue.style.minWidth = "4ch";
  volumeValue.style.textAlign = "end";
  volumeRow.controls.append(volume, volumeValue);
  volume.addEventListener("input", () => {
    actionError = "";
    controller.setVolume(Number(volume.value) / 100);
    render();
  });

  const status = document.createElement("div");
  status.className = "px-4 py-2 text-sm text-secondary";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.hidden = true;
  root.append(status);
  const scope = document.createElement("div");
  scope.className = "px-4 py-2 text-sm text-secondary";
  scope.textContent = copy(
    "页面保持打开时才能接收提醒。",
    "Keep this page open to receive alerts.",
  );
  root.append(scope);

  function render() {
    if (disposed) return;
    const state = controller.getState();
    const permission = state.permission;
    permissionRow.description.textContent = !state.supported
      ? copy(
          "此浏览器不支持系统通知。",
          "This browser does not support notifications.",
        )
      : permission === "denied"
        ? copy(
            "通知已被阻止。请在地址栏的站点设置中允许通知。",
            "Notifications are blocked. Allow them in this site's address-bar settings.",
          )
        : permission === "granted"
          ? copy(
              "完成时只显示会话标题和完成提示。",
              "Completion alerts show only the conversation title and a completion message.",
            )
          : copy(
              "允许后，完成时可以显示系统通知。",
              "Allow notifications to show system alerts when a task finishes.",
            );
    permissionButton.textContent = requesting
      ? copy("正在申请…", "Requesting…")
      : permission === "granted"
        ? copy("已允许", "Allowed")
        : permission === "denied"
          ? copy("已阻止", "Blocked")
          : copy("允许通知", "Allow notifications");
    permissionButton.disabled =
      requesting || !state.supported || permission !== "default";
    permissionButton.setAttribute("aria-busy", String(requesting));

    soundRow.description.textContent =
      state.audioState === "ready"
        ? copy(
            "已就绪，AI 完成时可在前台播放。",
            "Ready to play when AI finishes, including while this page is active.",
          )
        : state.audioState === "unavailable"
          ? copy(
              "此浏览器无法播放提示音。",
              "Sound playback is unavailable in this browser.",
            )
          : copy(
              "先试听一次，允许此页面播放声音。",
              "Test the sound once to allow playback on this page.",
            );
    previewButton.textContent = previewing
      ? copy("正在试听…", "Playing…")
      : copy("试听", "Test sound");
    previewButton.disabled = previewing || state.audioState === "unavailable";
    previewButton.setAttribute("aria-busy", String(previewing));
    const percent = Math.round(Math.max(0, Math.min(1, state.volume)) * 100);
    volume.value = String(percent);
    volumeValue.value = `${percent}%`;
    volume.setAttribute("aria-valuetext", `${percent}%`);
    volume.disabled = state.audioState === "unavailable";
    const messages: string[] = [];
    if (!state.dedupAvailable) {
      messages.push(
        copy(
          "当前浏览器无法协调多个标签页。请只保留一个页面接收提醒。",
          "This browser cannot coordinate alerts across tabs. Keep one page open for alerts.",
        ),
      );
    }
    if (actionError) messages.push(actionError);
    else if (state.error && !state.error.includes("标签页")) {
      const translations: Record<string, string> = {
        "提示音音量无法保存；当前页面仍使用所选音量。":
          "Sound volume could not be saved. This page still uses your selected volume.",
        "浏览器暂时无法播放提示音，请再次点击启用或试听。":
          "The browser could not play the sound. Test it again to enable playback.",
        "浏览器无法请求通知权限，请检查站点设置。":
          "The browser could not request notification permission. Check site settings.",
        "提示音播放失败，请再次试听。":
          "The sound could not be played. Test it again.",
        "无法读取提示音，请检查连接后再次试听。":
          "The sound could not be loaded. Check the connection and test it again.",
        "系统通知发送失败；提示音仍可独立使用。":
          "The system notification could not be shown. Sound can still be used independently.",
      };
      messages.push(
        chinese
          ? state.error
          : (translations[state.error] ??
              "An alert setting needs attention. Check the permission and sound status above."),
      );
    }
    const message = messages.join(" ");
    status.hidden = message.length === 0;
    status.textContent = message;
  }

  element.append(root);
  const unsubscribe = controller.subscribe(render);
  render();
  return () => {
    disposed = true;
    unsubscribe();
    root.remove();
  };
}
