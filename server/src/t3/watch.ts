/**
 * Turn settlement detection. After dispatching a message we watch T3's
 * projection_thread_sessions (the agent-run signal) and projection_turns
 * until the turn finishes. Command-only messages (e.g. `/compact`) settle via
 * the grace path if no turn row ever appears — though smoke testing showed
 * /compact does produce a normal turn row.
 */
import { hasActiveTurns, messageExists, threadSessionStatus, turnsForThread } from "./state";

export interface SettlementResult {
  outcome: "completed" | "error" | "no-turn";
  turns: Array<{ state: string; requestedAt: string; completedAt: string | null }>;
}

const CLOCK_SKEW_MS = 5_000;
const DEFAULT_NO_TURN_GRACE_MS = 90_000;

/**
 * Single non-blocking check. Returns null while the turn is still in flight.
 * The loop engine calls this on every tick; waitForTurnSettled loops it.
 */
export function checkSettlement(
  threadId: string,
  dispatchedAtIso: string,
  messageId: string,
  noTurnGraceMs: number = DEFAULT_NO_TURN_GRACE_MS,
): SettlementResult | null {
  const sinceIso = new Date(new Date(dispatchedAtIso).getTime() - CLOCK_SKEW_MS).toISOString();
  const turns = turnsForThread(threadId, sinceIso);
  const snapshot = turns.map((t) => ({
    state: t.state,
    requestedAt: t.requestedAt,
    completedAt: t.completedAt,
  }));

  // projection_turns marks a turn `completed` when its FIRST assistant message
  // finishes — the agent often keeps working for minutes after. The session row
  // is the real end-of-run signal: never settle while it says `running`, and
  // treat a session error newer than our dispatch as a turn error (turn rows
  // can stay `running` forever when the provider session dies).
  const session = threadSessionStatus(threadId);
  if (session?.status === "running") return null;
  if (session?.status === "error" && session.updatedAt >= sinceIso) {
    return { outcome: "error", turns: snapshot };
  }

  // Once the session reports a non-running status the agent run is genuinely
  // idle — trust that over the turn rows. A turn row can be stuck `running`
  // forever (provider session died without flipping it, or an unrelated later
  // turn started by direct interaction in T3 zombied), and gating thread-wide
  // on `hasActiveTurns` here would park the dispatch on it indefinitely. Only
  // fall back to the turn-level check when there's no session row to trust.
  if (!session && hasActiveTurns(threadId)) return null;

  const finished = turns.filter((t) => t.state === "completed" || t.state === "error");
  if (finished.length > 0) {
    const anyError = finished.some((t) => t.state === "error");
    return { outcome: anyError ? "error" : "completed", turns: snapshot };
  }

  const elapsed = Date.now() - new Date(dispatchedAtIso).getTime();
  if (elapsed >= noTurnGraceMs && messageExists(threadId, messageId)) {
    return { outcome: "no-turn", turns: snapshot };
  }
  return null;
}

export interface WaitOptions {
  noTurnGraceMs?: number;
  timeoutMs?: number;
  pollMs?: number;
  onPoll?: (info: { activeTurns: boolean; elapsedMs: number }) => void;
}

export interface TurnWaitResult extends SettlementResult {
  elapsedMs: number;
}

export async function waitForTurnSettled(
  threadId: string,
  dispatchedAtIso: string,
  messageId: string,
  opts: WaitOptions = {},
): Promise<TurnWaitResult | { outcome: "timeout"; turns: SettlementResult["turns"]; elapsedMs: number }> {
  const { timeoutMs, pollMs = 3_000 } = opts;
  const startedAt = Date.now();
  for (;;) {
    const elapsedMs = Date.now() - startedAt;
    const result = checkSettlement(threadId, dispatchedAtIso, messageId, opts.noTurnGraceMs);
    opts.onPoll?.({ activeTurns: result === null, elapsedMs });
    if (result) return { ...result, elapsedMs };
    if (timeoutMs && elapsedMs >= timeoutMs) {
      return { outcome: "timeout", turns: [], elapsedMs };
    }
    await Bun.sleep(pollMs);
  }
}
