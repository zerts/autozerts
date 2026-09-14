/**
 * Re-entrancy guard for the engine tick. A single hung await (e.g. a `gh` call
 * frozen across a sleep/wake) must not deadlock the engine forever, so the tick
 * lock is bounded: once a holder exceeds the watchdog the next fire abandons it
 * and takes over. Pure logic, kept separate so it's testable without importing
 * the whole engine graph.
 */
export const TICK_WATCHDOG_MS = 90_000;

/**
 * May a new tick start now? Yes when no tick holds the lock, or when the holder
 * has exceeded the watchdog bound (so a wedged tick is abandoned rather than
 * blocking the engine indefinitely).
 */
export function shouldStartTick(lockHeld: boolean, heldMs: number, watchdogMs = TICK_WATCHDOG_MS): boolean {
  return !lockHeld || heldMs >= watchdogMs;
}
