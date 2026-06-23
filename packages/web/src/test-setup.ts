import "@testing-library/jest-dom/vitest";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ── Canvas mock for PixiJS / Digital World tests ─────────────────────
// jsdom does not implement HTMLCanvasElement.prototype.getContext,
// which causes any test importing PixiJS or DigitalWorld components to crash.
// Provide a minimal stub so unit tests don't fail on canvas API calls.
HTMLCanvasElement.prototype.getContext = ((
  _contextId: string,
  _options?: unknown,
) => {
  return null;
}) as typeof HTMLCanvasElement.prototype.getContext;

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false
  })
});

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
