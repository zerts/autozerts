import { useSyncExternalStore } from "react";

/**
 * A tiny localStorage-backed store shared across every hook instance. The theme
 * toggle in the header and the floating theme studio both read/write the same
 * setting, so they must stay in lockstep — a per-component `useState` would let
 * them drift. This keeps one source of truth and notifies all subscribers on
 * change.
 */
export interface SettingStore<T> {
  get: () => T;
  set: (next: T) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createSettingStore<T>(opts: {
  key: string;
  /** Parse the raw localStorage string (null when unset) into a value. */
  parse: (raw: string | null) => T;
  /** Serialize for storage; return null to clear the key (e.g. for defaults). */
  serialize: (value: T) => string | null;
  /** Side effect that reflects the value onto the DOM (class / data-attr). */
  apply: (value: T) => void;
}): SettingStore<T> {
  const listeners = new Set<() => void>();
  let value = opts.parse(localStorage.getItem(opts.key));
  opts.apply(value);

  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      const serialized = opts.serialize(next);
      if (serialized === null) localStorage.removeItem(opts.key);
      else localStorage.setItem(opts.key, serialized);
      opts.apply(next);
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useSetting<T>(store: SettingStore<T>): [T, (next: T) => void] {
  const value = useSyncExternalStore(store.subscribe, store.get, store.get);
  return [value, store.set];
}

/**
 * Suppress CSS transitions for the instant of a palette/mode swap so elements
 * with `transition-colors` don't animate their whole palette change. The style
 * is removed on the next frame, after paint, leaving hover transitions intact.
 */
export function withoutTransitions(swap: () => void): void {
  const stop = document.createElement("style");
  stop.textContent = "*,*::before,*::after{transition:none !important}";
  document.head.appendChild(stop);
  swap();
  void document.documentElement.offsetHeight; // force reflow before un-suppressing
  requestAnimationFrame(() => stop.remove());
}
