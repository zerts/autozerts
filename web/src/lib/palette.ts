import { createSettingStore, useSetting, withoutTransitions } from "./setting-store";

/**
 * The available palettes. Each `id` matches a `[data-theme="…"]` block in
 * index.css; swatch colors here are just for the picker preview (static, so
 * they live in JS rather than being read back out of CSS). "slate" is the base
 * palette — it needs no data-theme override, so selecting it clears the attr.
 */
export interface PaletteDef {
  id: string;
  name: string;
  blurb: string;
  /** [primary, accent surface, background] — rendered as the preview swatch. */
  swatch: [string, string, string];
}

export const PALETTES: PaletteDef[] = [
  {
    id: "slate",
    name: "Slate",
    blurb: "Neutral & calm",
    swatch: ["oklch(0.3 0 0)", "oklch(0.93 0 0)", "oklch(1 0 0)"],
  },
  {
    id: "vercel",
    name: "Modern",
    blurb: "Sharp borders, white cards",
    swatch: ["oklch(0.205 0 0)", "oklch(0.92 0 0)", "oklch(0.985 0 0)"],
  },
  {
    id: "ocean",
    name: "Ocean",
    blurb: "Cool teal, soft & round",
    swatch: ["oklch(0.56 0.12 215)", "oklch(0.93 0.035 210)", "oklch(0.99 0.006 225)"],
  },
  {
    id: "sunset",
    name: "Sunset",
    blurb: "Warm amber, crisp edges",
    swatch: ["oklch(0.64 0.15 52)", "oklch(0.93 0.04 65)", "oklch(0.99 0.008 75)"],
  },
  {
    id: "forest",
    name: "Forest",
    blurb: "Deep green, tight radius",
    swatch: ["oklch(0.52 0.11 155)", "oklch(0.93 0.035 150)", "oklch(0.99 0.006 150)"],
  },
  {
    id: "grape",
    name: "Grape",
    blurb: "Vivid violet, pillowy",
    swatch: ["oklch(0.53 0.18 295)", "oklch(0.93 0.04 298)", "oklch(0.99 0.006 300)"],
  },
];

export const DEFAULT_PALETTE = "slate";
const VALID = new Set(PALETTES.map((p) => p.id));

/** Reflect the palette onto <html data-theme>. Slate is the default → no attr. */
export function applyPalette(id: string): void {
  const root = document.documentElement;
  withoutTransitions(() => {
    if (id === DEFAULT_PALETTE) delete root.dataset.theme;
    else root.dataset.theme = id;
  });
}

const store = createSettingStore<string>({
  key: "palette",
  parse: (raw) => (raw && VALID.has(raw) ? raw : DEFAULT_PALETTE),
  serialize: (id) => (id === DEFAULT_PALETTE ? null : id),
  apply: applyPalette,
});

/** Active palette id + setter, synced across every instance. */
export function usePalette(): [string, (id: string) => void] {
  return useSetting(store);
}
