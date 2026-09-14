import { useEffect, useState } from "react";
import { Check, Monitor, Moon, Palette, Sun, X } from "lucide-react";
import { PALETTES } from "@/lib/palette";
import { usePalette } from "@/lib/palette";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const MODES: { value: Theme; icon: typeof Sun; label: string }[] = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "dark", icon: Moon, label: "Dark" },
  { value: "system", icon: Monitor, label: "System" },
];

/**
 * A floating, fixed bottom-right control for previewing palettes and light/dark
 * mode — styled after a framework dev indicator. Everything it changes is a
 * design token, so swapping palettes restyles the whole dashboard live with no
 * rebuild. Collapsed it's a small pill; click to expand the picker.
 */
export function ThemeStudio() {
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = usePalette();
  const { theme, setTheme } = useTheme();
  const mode = MODES.find((m) => m.value === theme) ?? MODES[0];
  const ModeIcon = mode.icon;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="relative">
      {/* Transparent catch-all to dismiss on outside click while open. */}
      {open && <div className="fixed inset-0 -z-10" onClick={() => setOpen(false)} aria-hidden />}

      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-64 origin-bottom-right overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-[var(--elevation)]">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold tracking-tight">
              <Palette className="size-3.5 text-primary" /> Theme studio
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close theme studio"
              className="rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>

          <div className="space-y-1 p-2">
            <p className="px-1 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Palette
            </p>
            {PALETTES.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPalette(p.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                  p.id === palette ? "bg-accent text-accent-foreground" : "hover:bg-secondary",
                )}
              >
                <span className="flex shrink-0 -space-x-1">
                  {p.swatch.map((c, i) => (
                    <span
                      key={i}
                      className="size-4 rounded-full ring-1 ring-border/60"
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium leading-tight">{p.name}</span>
                  <span className="block truncate text-[10px] leading-tight text-muted-foreground">
                    {p.blurb}
                  </span>
                </span>
                {p.id === palette && <Check className="size-3.5 shrink-0 text-primary" />}
              </button>
            ))}
          </div>

          <div className="border-t p-2">
            <p className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Appearance
            </p>
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-secondary/60 p-1">
              {MODES.map(({ value, icon: Icon, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTheme(value)}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-md py-1.5 text-[10px] font-medium transition-colors",
                    theme === value
                      ? "bg-background text-foreground shadow-[var(--elevation)]"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5" />
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Theme studio"
        aria-label="Open theme studio"
        aria-expanded={open}
        className="flex items-center justify-center rounded-full bg-popover/90 p-2 text-foreground shadow-[var(--elevation)] backdrop-blur transition-colors hover:bg-popover"
      >
        <ModeIcon className="size-4 text-primary" />
      </button>
    </div>
  );
}
