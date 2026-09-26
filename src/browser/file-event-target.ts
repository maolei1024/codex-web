const composerFileTargetSelectors = [
  ".ProseMirror",
  '[data-testid="composer-input"]',
  "[data-composer-attachments-row]",
  "[data-composer-overlay-floating-ui]",
];

export function shouldHandleFileEventTarget(
  target: EventTarget | null,
): boolean {
  return (
    target instanceof Element &&
    composerFileTargetSelectors.some((selector) => target.closest(selector))
  );
}
