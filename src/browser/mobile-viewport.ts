// The upstream webview was built for a fixed-size Electron window, so it
// sizes itself with 100vh (`#root { height: 100vh }` in the app stylesheet)
// and centers dialogs against the layout viewport. Mobile browsers break both
// assumptions: 100vh is the *large* viewport (URL bar hidden), and the
// software keyboard shrinks only the visual viewport while position:fixed
// elements stay anchored to the layout viewport. The result is the composer's
// bottom action bar sitting below the visible area, and dialogs half-hidden
// behind the keyboard or appearing panned off to a corner after iOS restores
// from an input-focus pan.
//
// This guard mirrors the visual viewport into CSS custom properties and a
// keyboard flag on <html>. The companion CSS lives in
// patches/webview-style.patch: it re-bases #root on the visible height and
// keeps .codex-dialog inside the visible area.
const KEYBOARD_MIN_OVERLAP_PX = 80;

export const VIEWPORT_HEIGHT_VARIABLE = "--codex-web-visual-viewport-height";
export const VIEWPORT_OFFSET_TOP_VARIABLE =
  "--codex-web-visual-viewport-offset-top";
export const KEYBOARD_ATTRIBUTE = "data-codex-web-keyboard";

export function isKeyboardLikelyOpen({
  visualViewportHeight,
  visualViewportScale,
  windowInnerHeight,
}: {
  visualViewportHeight: number;
  visualViewportScale: number;
  windowInnerHeight: number;
}): boolean {
  // A pinch zoom also shrinks the visual viewport; only treat a shrunken
  // viewport as "keyboard" at (roughly) 1:1 scale so zooming does not collapse
  // the app layout.
  return (
    visualViewportScale <= 1.01 &&
    windowInnerHeight - visualViewportHeight > KEYBOARD_MIN_OVERLAP_PX
  );
}

export function installMobileViewportGuard(): void {
  const visualViewport = window.visualViewport;
  if (!visualViewport) {
    return;
  }
  if (!matchMedia("(pointer: coarse)").matches) {
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

    const keyboardOpen = isKeyboardLikelyOpen({
      visualViewportHeight: visualViewport.height,
      visualViewportScale: scale,
      windowInnerHeight: window.innerHeight,
    });

    if (keyboardOpen) {
      root.setAttribute(KEYBOARD_ATTRIBUTE, "open");
    } else {
      root.removeAttribute(KEYBOARD_ATTRIBUTE);
    }

    // With #root pinned to the visible height, any document-level scroll or
    // leftover pan (iOS keeps the page panned after the keyboard closes,
    // which is how the app ends up "stuck" towards a corner) just hides UI.
    // Scroll back whenever the browser is at 1:1 scale; when the user pinch
    // zooms we leave their pan alone.
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
}
