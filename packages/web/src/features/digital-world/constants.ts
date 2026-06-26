// ── Canvas background ────────────────────────────────────────────────
// Base canvas color (a Graphics gradient layer is drawn on top for the
// 0xf0f4ff → 0xffffff effect; this constant remains as the fallback /
// app.backgroundColor).
export const CANVAS_BG_COLOR = 0xffffff;

// Background gradient endpoints (§9.3.3 — light blue → white).
export const CANVAS_BG_GRADIENT_TOP = 0xf0f4ff;
export const CANVAS_BG_GRADIENT_BOTTOM = 0xffffff;

// ── Grid ─────────────────────────────────────────────────────────────
// §9.3.3: dotted grid style (small dots at each intersection instead of
// solid lines) for a lighter, more modern look.
export const GRID_COLOR = 0xc7d2fe;
export const GRID_SPACING = 40;
export const GRID_DOT_RADIUS = 1; // radius of each grid dot

// ── Roads ────────────────────────────────────────────────────────────
// §9.3.3: double-line road style with a dashed center line.
export const ROAD_COLOR = 0xd1d5db;       // outer road edges
export const ROAD_WIDTH = 6;              // total road width
export const ROAD_CENTER_COLOR = 0xfbbf24; // dashed center line (amber)
export const ROAD_CENTER_WIDTH = 1;       // center line width
export const ROAD_DASH_LENGTH = 6;        // dashed center line segment length
export const ROAD_DASH_GAP = 4;           // gap between dashes
export const ROAD_INTERSECTION_RADIUS = ROAD_WIDTH / 2 + 1; // rounded intersection cap

// ── Nodes ────────────────────────────────────────────────────────────
export const NODE_BORDER_RADIUS = 8;

// ── Task 13 (§9.5.4): Theme system ───────────────────────────────────
// A WorldTheme bundles the canvas colors that vary between light/dark
// modes. Canvas layers (background, grid, roads, nodes, labels) read from
// getCurrentWorldTheme() so toggling the theme recolors the world without
// code changes at each call site.

export interface WorldTheme {
  name: "light" | "dark";
  /** Solid fallback background color (app.backgroundColor). */
  canvasBg: number;
  /** Vertical gradient endpoints drawn over the canvasBg. */
  canvasBgGradientTop: number;
  canvasBgGradientBottom: number;
  /** Dotted grid intersection color. */
  gridColor: number;
  /** Outer road surface color. */
  roadColor: number;
  /** Dashed road center line color. */
  roadCenterColor: number;
  /** Workstation card background fill. */
  nodeBg: number;
  /** Workstation card border / accent stripe color (kept per-type elsewhere). */
  nodeBorder: number;
  /** Workstation name label text color. */
  textColor: number;
}

export const LIGHT_THEME: WorldTheme = {
  name: "light",
  canvasBg: 0xffffff,
  canvasBgGradientTop: 0xf0f4ff,
  canvasBgGradientBottom: 0xffffff,
  gridColor: 0xc7d2fe,
  roadColor: 0xd1d5db,
  roadCenterColor: 0xfbbf24,
  nodeBg: 0xffffff,
  nodeBorder: 0xe5e7eb,
  textColor: 0x1f2937,
};

export const DARK_THEME: WorldTheme = {
  name: "dark",
  canvasBg: 0x0f172a,
  canvasBgGradientTop: 0x0b1220,
  canvasBgGradientBottom: 0x111827,
  gridColor: 0x1e3a5f,
  roadColor: 0x334155,
  roadCenterColor: 0xfbbf24,
  nodeBg: 0x1e293b,
  nodeBorder: 0x475569,
  textColor: 0xe2e8f0,
};

// Module-level active theme. Defaults to light (matching the pre-existing
// hardcoded constants) so existing behavior is unchanged until a caller
// explicitly switches themes.
let currentWorldTheme: WorldTheme = LIGHT_THEME;

/** Read the active world theme (used by canvas layers). */
export function getCurrentWorldTheme(): WorldTheme {
  return currentWorldTheme;
}

/** Switch the active world theme. Callers should trigger a world redraw. */
export function setCurrentWorldTheme(theme: WorldTheme): void {
  currentWorldTheme = theme;
}

