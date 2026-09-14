/**
 * Smoke B: dispatch `/compact` as a plain turn on an existing thread and
 * observe how it settles — does it produce a projection_turns row, or settle
 * via the no-turn grace path? This decides how the loop engine treats
 * Compact Turns.
 *
 * Usage: bun run server/scripts/smoke-b.ts <threadId>
 */
import { dispatchExistingThreadTurn, newId } from "../src/t3/client";
import { waitForTurnSettled } from "../src/t3/watch";

const threadId = process.argv[2];
if (!threadId) {
  console.error("Usage: bun run server/scripts/smoke-b.ts <threadId>");
  process.exit(1);
}

const messageId = newId();
const dispatchedAt = new Date().toISOString();

console.log(`Dispatching /compact on thread ${threadId}`);
await dispatchExistingThreadTurn({ threadId, text: "/compact", messageId });

const result = await waitForTurnSettled(threadId, dispatchedAt, messageId, {
  timeoutMs: 5 * 60 * 1000,
  noTurnGraceMs: 60_000,
  onPoll: ({ activeTurns, elapsedMs }) => {
    if (elapsedMs % 15000 < 3000) console.log(`  ...${Math.round(elapsedMs / 1000)}s active=${activeTurns}`);
  },
});

console.log("Settle result:", JSON.stringify(result, null, 2));
console.log(`\nSMOKE B ${result.outcome === "completed" || result.outcome === "no-turn" ? "PASS" : "FAIL"}`);
console.log(`Compact settles via: ${result.outcome === "no-turn" ? "grace path (no turn row)" : "normal turn row"}`);
