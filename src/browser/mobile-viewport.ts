// The upstream webview assumes a fixed-size Electron window. Mobile browsers
// instead resize and pan the visual viewport around the URL bar and keyboard.
const KEYBOARD_MIN_OVERLAP_PX = 80;

export const VIEWPORT_HEIGHT_VARIABLE = "--codex-web-visual-viewport-height";
export const VIEWPORT_OFFSET_TOP_VARIABLE =
  "--codex-web-visual-viewport-offset-top";
export const KEYBOARD_ATTRIBUTE = "data-codex-web-keyboard";
export const VIEWPORT_DEBUG_HASH = "#codex-web-viewport-debug";

export function isKeyboardLikelyOpen({
  visualViewportHeight,
  visualViewportScale,
  windowInnerHeight,
}: {
  visualViewportHeight: number;
  visualViewportScale: number;
  windowInnerHeight: number;
}): boolean {
  return (
    visualViewportScale <= 1.01 &&
    windowInnerHeight - visualViewportHeight > KEYBOARD_MIN_OVERLAP_PX
  );
}

export function shouldInstallGuard({
  coarsePointer,
  narrowViewport,
  touchCapable,
}: {
  coarsePointer: boolean;
  narrowViewport: boolean;
  touchCapable: boolean;
}): boolean {
  return coarsePointer || narrowViewport || touchCapable;
}

function shortLabel(element: Element): string {
  const className =
    typeof element.className === "string"
      ? element.className.trim().split(/\s+/).slice(0, 4).join(".")
      : "";
  const id = element.id ? `#${element.id}` : "";
  return `${element.tagName.toLowerCase()}${id}${className ? `.${className}` : ""}`.slice(
    0,
    70,
  );
}

function describeViewportOverflow(): string[] {
  const viewportHeight = window.innerHeight;
  const lines: string[] = [];
  const root = document.getElementById("root");
  if (root) {
    const rect = root.getBoundingClientRect();
    lines.push(`#root h=${Math.round(rect.height)} top=${Math.round(rect.top)}`);
  }
  const composer = document.querySelector(
    '.ProseMirror, textarea, [contenteditable="true"]',
  );
  if (composer) {
    const rect = composer.getBoundingClientRect();
    lines.push(
      `composer bottom=${Math.round(rect.bottom)} (viewport ${viewportHeight})`,
    );
  } else {
    lines.push("composer: not found");
  }
  let listed = 0;
  for (const element of document.body.querySelectorAll("*")) {
    if (listed >= 5) {
      lines.push("...more overflowing elements truncated");
      break;
    }
    const rect = element.getBoundingClientRect();
    if (rect.height > viewportHeight + 4) {
      const style = getComputedStyle(element);
      const scrollable =
        style.overflowY === "auto" || style.overflowY === "scroll";
      lines.push(
        `${scrollable ? "scroll" : "OVER"} ${shortLabel(element)} h=${Math.round(rect.height)}`,
      );
      listed += 1;
    }
  }
  if (listed === 0) {
    lines.push("no over-tall elements");
  }
  return lines;
}

function installViewportDebugBadge(visualViewport: VisualViewport): void {
  const badge = document.createElement("div");
  badge.style.cssText = [
    "position:fixed",
    "left:8px",
    "top:8px",
    "z-index:2147483647",
    "background:rgba(0,0,0,0.78)",
    "color:#0f0",
    "font:10px/1.4 monospace",
    "padding:6px 8px",
    "border-radius:6px",
    "pointer-events:none",
    "white-space:pre",
    "max-width:94vw",
    "overflow:hidden",
  ].join(";");
  const update = (): void => {
    const dvhSupported =
      typeof CSS !== "undefined" && CSS.supports?.("height", "100dvh");
    badge.textContent = [
      `inner ${window.innerWidth}x${window.innerHeight}`,
      `vv ${Math.round(visualViewport.width)}x${Math.round(visualViewport.height)} @${visualViewport.scale.toFixed(2)}`,
      `vvOffset ${Math.round(visualViewport.offsetLeft)},${Math.round(visualViewport.offsetTop)} scroll ${Math.round(window.scrollX)},${Math.round(window.scrollY)}`,
      `dvh:${dvhSupported ? "yes" : "NO"} kb:${document.documentElement.getAttribute(KEYBOARD_ATTRIBUTE) ?? "closed"}`,
      ...describeViewportOverflow(),
      `ua ${navigator.userAgent.slice(0, 76)}`,
      `   ${navigator.userAgent.slice(76, 152)}`,
    ].join("\n");
  };
  visualViewport.addEventListener("resize", update);
  visualViewport.addEventListener("scroll", update);
  window.setInterval(update, 1_000);
  update();
  if (document.body) {
    document.body.append(badge);
  } else {
    window.addEventListener("DOMContentLoaded", () => document.body.append(badge));
  }
}

export function installMobileViewportGuard(): void {
  const visualViewport = window.visualViewport;
  if (!visualViewport) {
    return;
  }
  const install = shouldInstallGuard({
    coarsePointer: matchMedia("(pointer: coarse)").matches,
    narrowViewport: matchMedia("(max-width: 768px)").matches,
    touchCapable: "ontouchstart" in window,
  });
  const debug = window.location.hash === VIEWPORT_DEBUG_HASH;
  if (!install && !debug) {
    return;
  }

  const root = document.documentElement;
  const apply = (): void => {
    const scale = visualViewport.scale || 1;
    root.style.setProperty(
      VIEWPORT_HEIGHT_VARIABLE,
      `${Math.round(visualViewport.height)}px`,
    );
    root.style.setProperty(
      VIEWPORT_OFFSET_TOP_VARIABLE,
      `${Math.round(visualViewport.offsetTop)}px`,
    );

    if (
      isKeyboardLikelyOpen({
        visualViewportHeight: visualViewport.height,
        visualViewportScale: scale,
        windowInnerHeight: window.innerHeight,
      })
    ) {
      root.setAttribute(KEYBOARD_ATTRIBUTE, "open");
    } else {
      root.removeAttribute(KEYBOARD_ATTRIBUTE);
    }

    if (scale <= 1.01 && (window.scrollY !== 0 || window.scrollX !== 0)) {
      window.scrollTo(0, 0);
    }
  };

  visualViewport.addEventListener("resize", apply);
  visualViewport.addEventListener("scroll", apply);
  window.addEventListener("orientationchange", () => {
    window.setTimeout(apply, 250);
  });
  apply();

  if (debug) {
    installViewportDebugBadge(visualViewport);
  }
}
