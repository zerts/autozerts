import { useEffect, useState } from "react";

/**
 * Per-project accent color, used to tint loop/task cards with a subtle gradient.
 *
 * Resolution order:
 *  1. an explicit config override (the color selector in the Config page), else
 *  2. the dominant color sampled from the project icon (canvas, client-side), else
 *  3. a stable color hashed from the repo name (covers projects with no icon, or
 *     a cross-origin icon whose pixels can't be read).
 *
 * Sampled colors are cached per icon URL (and in-flight loads deduped) so the
 * many cards sharing a repo all resolve from one decode. Everything is returned
 * as `#rrggbb` so it drops straight into `color-mix()` and `<input type=color>`.
 */

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** A stable, pleasant accent derived from a string — the no-icon fallback. */
export function fallbackColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  const hue = ((hash % 360) + 360) % 360;
  // Fixed saturation/lightness so every project reads as the same "weight".
  return hslToHex(hue, 0.62, 0.55);
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = (
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  ) as [number, number, number];
  return toHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/**
 * Draw the icon small and pick its dominant *vivid* color: average the opaque
 * pixels weighted by saturation, so a logo's brand color wins over its white/
 * gray padding. Falls back to a plain average for monochrome marks. Throws if
 * the canvas is tainted (cross-origin icon without CORS) — caller handles it.
 */
function sampleIcon(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return reject(new Error("no 2d context"));
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);

        let vr = 0, vg = 0, vb = 0, vw = 0; // saturation-weighted accumulator
        let ar = 0, ag = 0, ab = 0, aw = 0; // plain opaque average
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3];
          if (a < 128) continue;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const sat = max === 0 ? 0 : (max - min) / max;
          ar += r; ag += g; ab += b; aw += 1;
          const w = sat * sat; // emphasise truly colorful pixels
          vr += r * w; vg += g * w; vb += b * w; vw += w;
        }
        if (aw === 0) return reject(new Error("transparent icon"));
        if (vw > 0.5) resolve(toHex(vr / vw, vg / vw, vb / vw));
        else resolve(toHex(ar / aw, ag / aw, ab / aw)); // monochrome → plain average
      } catch (err) {
        reject(err as Error);
      }
    };
    img.onerror = () => reject(new Error("icon load failed"));
    img.src = url;
  });
}

function loadProjectColor(key: string, iconUrl: string | null): Promise<string> {
  if (!iconUrl) return Promise.resolve(fallbackColor(key));
  const hit = cache.get(iconUrl);
  if (hit) return Promise.resolve(hit);
  const inflight = pending.get(iconUrl);
  if (inflight) return inflight;
  const p = sampleIcon(iconUrl)
    .catch(() => fallbackColor(key))
    .then((color) => {
      cache.set(iconUrl, color);
      pending.delete(iconUrl);
      return color;
    });
  pending.set(iconUrl, p);
  return p;
}

/**
 * The effective accent color for a project. An explicit `override` short-circuits
 * sampling; otherwise the icon is sampled (async, cached) and the hook re-renders
 * once resolved. Starts from any cached/fallback value so cards never flash.
 */
export function useProjectColor(key: string, iconUrl: string | null, override?: string | null): string {
  const trimmed = override?.trim();
  const initial = trimmed || (iconUrl && cache.get(iconUrl)) || fallbackColor(key);
  const [color, setColor] = useState(initial);

  useEffect(() => {
    if (trimmed) {
      setColor(trimmed);
      return;
    }
    let live = true;
    loadProjectColor(key, iconUrl).then((c) => {
      if (live) setColor(c);
    });
    return () => {
      live = false;
    };
  }, [key, iconUrl, trimmed]);

  return color;
}
