// ── Canvas background ────────────────────────────────────────────────
// Base canvas color — used as app.backgroundColor (Batch 5 Phase 1 removed
// the FillGradient layer; the solid background color is the sole canvas
// background, with a matching CSS fallback on the canvas host).
export const CANVAS_BG_COLOR = 0xffffff;

// Legacy gradient endpoints (kept for theme completeness; no longer rendered
// by PixiJS after Batch 5 Phase 1 removed the FillGradient layer).
export const CANVAS_BG_GRADIENT_TOP = 0xf0f4ff;
export const CANVAS_BG_GRADIENT_BOTTOM = 0xffffff;

// ── Grid ─────────────────────────────────────────────────────────────
// Batch 5 Phase 2 (§9.5 — Control Room): dotted grid → thin line cross-grid.
export const GRID_COLOR = 0xc7d2fe;
export const GRID_SPACING = 40;
export const GRID_DOT_RADIUS = 1; // legacy: kept for backwards compat

// Line grid style (Phase 2):
export const GRID_LINE_WIDTH = 0.5;     // minor line width
export const GRID_LINE_ALPHA = 0.15;   // minor line alpha
export const GRID_MAJOR_EVERY = 5;     // every Nth line is a "major" line
export const GRID_MAJOR_LINE_WIDTH = 0.5;
export const GRID_MAJOR_LINE_ALPHA = 0.3; // slightly brighter than minor
// Parallax: grid moves at 0.92x camera speed (offset = 8% of camera position).
export const GRID_PARALLAX_FACTOR = 0.08;

// ── Roads ────────────────────────────────────────────────────────────
// Batch 5 Phase 2: double-line+dashed → single line with type-based coloring.
export const ROAD_COLOR = 0xd1d5db;       // legacy fallback road color
export const ROAD_WIDTH = 6;              // total road width (single line)
export const ROAD_CENTER_COLOR = 0xfbbf24; // legacy center line color
export const ROAD_CENTER_WIDTH = 1;       // legacy center line width
export const ROAD_DASH_LENGTH = 6;        // legacy dash length
export const ROAD_DASH_GAP = 4;           // legacy dash gap
export const ROAD_INTERSECTION_RADIUS = ROAD_WIDTH / 2 + 1; // rounded intersection cap

// ── Road type colors (Batch 5 Phase 2 §3.4) ───────────────────────────
// Roads are colored by inferred type (data / product / control flow).
export type RoadType = "data" | "product" | "control";

export const ROAD_TYPE_COLORS: Record<RoadType, number> = {
  data: 0x06b6d4,    // cyan — data flow (materials, inputs)
  product: 0xa855f7, // purple — product flow (videos, artifacts, publish)
  control: 0xfbbf24, // amber — control flow (navigation, status)
};

// ── Nodes ────────────────────────────────────────────────────────────
export const NODE_BORDER_RADIUS = 8;

// ── Task 13 (§9.5.4): Theme system ───────────────────────────────────
// A WorldTheme bundles the canvas colors that vary between light/dark
// modes. Canvas layers (background, grid, roads, nodes, labels) read from
// getCurrentWorldTheme() so toggling the theme recolors the world without
// code changes at each call site.

export interface WorldTheme {
  name: "light" | "dark" | "control_room";
  /** Solid fallback background color (app.backgroundColor). */
  canvasBg: number;
  /** Vertical gradient endpoints (legacy — no longer rendered by PixiJS). */
  canvasBgGradientTop: number;
  canvasBgGradientBottom: number;
  /** Grid line color. */
  gridColor: number;
  /** Outer road surface color (legacy fallback; type colors are used by default). */
  roadColor: number;
  /** Road center line color (legacy). */
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

// Batch 5 Phase 2 (§9.5 §3.1): CONTROL_ROOM theme — "data command center"
// aesthetic (Grafana + Tron). Deep space blue-black canvas with cyan/purple/
// amber accents. This is the default theme.
export const CONTROL_ROOM_THEME: WorldTheme = {
  name: "control_room",
  canvasBg: 0x0a0e17,
  canvasBgGradientTop: 0x0d1321,
  canvasBgGradientBottom: 0x0f1729,
  gridColor: 0x1a2744,
  roadColor: 0x1e3050,
  roadCenterColor: 0x06b6d4,
  nodeBg: 0x141c2b,
  nodeBorder: 0x1e3a5f,
  textColor: 0xc8d6e5,
};

// Module-level active theme. Batch 5 Phase 2: defaults to CONTROL_ROOM
// (the new "data command center" aesthetic). LIGHT_THEME and DARK_THEME
// remain available for runtime switching.
let currentWorldTheme: WorldTheme = CONTROL_ROOM_THEME;

/** Read the active world theme (used by canvas layers). */
export function getCurrentWorldTheme(): WorldTheme {
  return currentWorldTheme;
}

/** Switch the active world theme. Callers should trigger a world redraw. */
export function setCurrentWorldTheme(theme: WorldTheme): void {
  currentWorldTheme = theme;
}
