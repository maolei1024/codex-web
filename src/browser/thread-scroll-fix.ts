// The webview's open-thread auto-scroll anchors to the absolute bottom of
// the scroll container. Long threads end with large empty spacer regions
// (reserved for the scroll-new-turn-to-top behavior), so the viewport can
// land in a text-free void thousands of pixels below the actual messages,
// leaving the thread looking blank.
//
// Correction rule: only when the LAST content element (text, image, canvas
// or video) ends well above the container's viewport — i.e. every piece of
// content is off-screen upwards — scroll the container so that element is
// back in view. This deliberately leaves alone the healthy states that share
// the same scroll offset: a fresh turn anchored at the viewport top with the
// spacer below it, and threads that end in a full-viewport image. Any user
// interaction cancels pending corrections, and at most one correction runs
// per navigation.

// Long tail: heavy threads can take 20s+ to arrive over slow links, and a
// user staring at a blank view has no interaction that would cancel.
const CORRECTION_ATTEMPT_DELAYS_MS = [
  600, 1_500, 3_000, 5_000, 8_000, 13_000, 21_000, 34_000,
];
const SCROLLABLE_SLACK_PX = 100;
const VOID_MARGIN_PX = 200;
const BOTTOM_PADDING_PX = 16;
const MIN_CONTENT_SIZE_PX = 8;

let attemptTimeoutIds: number[] = [];
let correctionCancelled = false;
let fixInstalled = false;

function cancelCorrections(): void {
  correctionCancelled = true;
}

function findThreadScrollContainer(): HTMLElement | null {
  const container = document.querySelector(".thread-scroll-container");
  return container instanceof HTMLElement ? container : null;
}

function hasVisibleBox(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > MIN_CONTENT_SIZE_PX && rect.height > MIN_CONTENT_SIZE_PX;
}

const CONTENT_TAG_NAMES = new Set(["IMG", "CANVAS", "VIDEO"]);

function findLastContentElement(container: HTMLElement): HTMLElement | null {
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          return node.textContent && node.textContent.trim().length > 0
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP;
        }
        return CONTENT_TAG_NAMES.has((node as Element).tagName)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    },
  );

  let lastContent: HTMLElement | null = null;
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const element =
      current.nodeType === Node.TEXT_NODE
        ? current.parentElement
        : (current as HTMLElement);
    if (element && hasVisibleBox(element)) {
      lastContent = element;
    }
  }
  return lastContent;
}

function correctScrollIfInVoid(): boolean {
  const container = findThreadScrollContainer();
  if (!container) {
    return false;
  }

  if (container.scrollHeight <= container.clientHeight + SCROLLABLE_SLACK_PX) {
    return false;
  }

  const lastContent = findLastContentElement(container);
  if (!lastContent) {
    return false;
  }

  const containerRect = container.getBoundingClientRect();
  const lastContentRect = lastContent.getBoundingClientRect();

  // Healthy whenever any trailing content reaches the viewport (or sits
  // below it). Only an all-content-above-viewport state is the void.
  if (lastContentRect.bottom > containerRect.top - VOID_MARGIN_PX) {
    return false;
  }

  console.warn(
    "[electron-stub] thread view landed in an empty scroll region; scrolling last content into view",
  );
  const containerBottom = containerRect.top + container.clientHeight;
  container.scrollTop -=
    containerBottom - lastContentRect.bottom - BOTTOM_PADDING_PX;
  return true;
}

export function scheduleThreadScrollVoidCheck(): void {
  for (const timeoutId of attemptTimeoutIds) {
    window.clearTimeout(timeoutId);
  }
  attemptTimeoutIds = [];
  correctionCancelled = false;

  for (const delay of CORRECTION_ATTEMPT_DELAYS_MS) {
    attemptTimeoutIds.push(
      window.setTimeout(() => {
        if (correctionCancelled) {
          return;
        }
        if (correctScrollIfInVoid()) {
          correctionCancelled = true;
        }
      }, delay),
    );
  }
}

export function installThreadScrollVoidFix(): void {
  if (fixInstalled || typeof window === "undefined") {
    return;
  }
  fixInstalled = true;

  const listenerOptions = { capture: true, passive: true } as const;
  window.addEventListener("wheel", cancelCorrections, listenerOptions);
  window.addEventListener("touchmove", cancelCorrections, listenerOptions);
  window.addEventListener("keydown", cancelCorrections, listenerOptions);
  window.addEventListener("pointerdown", cancelCorrections, listenerOptions);

  scheduleThreadScrollVoidCheck();
}
