import { createSettingStore, useSetting, withoutTransitions } from "./setting-store";

export type Theme = "light" | "dark" | "system";

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Resolve light/dark/system to a concrete mode and toggle the `.dark` class. */
function applyTheme(theme: Theme): void {
  const dark = theme === "dark" || (theme === "system" && systemPrefersDark());
  withoutTransitions(() => document.documentElement.classList.toggle("dark", dark));
}

const store = createSettingStore<Theme>({
  key: "theme",
  parse: (raw) => (raw === "light" || raw === "dark" ? raw : "system"),
  serialize: (theme) => (theme === "system" ? null : theme),
  apply: applyTheme,
});

// While following the system, re-apply when the OS preference flips.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (store.get() === "system") applyTheme("system");
});

/**
 * App theme: light / dark / follow-system, persisted to localStorage and shared
 * across every hook instance (header toggle + theme studio). The inline boot
 * script in index.html applies the same logic before React mounts to avoid a
 * flash; this hook keeps it in sync and reacts to OS changes while on "system".
 */
export function useTheme(): { theme: Theme; setTheme: (next: Theme) => void } {
  const [theme, setTheme] = useSetting(store);
  return { theme, setTheme };
}
