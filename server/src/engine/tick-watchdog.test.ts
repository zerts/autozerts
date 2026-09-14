import { describe, expect, test } from "bun:test";
import { shouldStartTick, TICK_WATCHDOG_MS } from "./tick-watchdog";

describe("tick watchdog", () => {
  test("starts when no tick holds the lock", () => {
    expect(shouldStartTick(false, 0)).toBe(true);
  });

  test("defers to a tick that is within the watchdog bound", () => {
    expect(shouldStartTick(true, 0)).toBe(false);
    expect(shouldStartTick(true, TICK_WATCHDOG_MS - 1)).toBe(false);
  });

  test("takes over a tick that has held the lock past the watchdog bound", () => {
    expect(shouldStartTick(true, TICK_WATCHDOG_MS)).toBe(true);
    expect(shouldStartTick(true, TICK_WATCHDOG_MS + 60_000)).toBe(true);
  });
});
