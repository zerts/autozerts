/**
 * Smoke A+C: dispatch a new thread with worktree bootstrap into a registered
 * T3 project, wait for the turn to settle, and verify the thread actually runs
 * inside the bootstrapped worktree on the requested branch (the property the
 * Task Branch design depends on).
 *
 * Usage: bun run server/scripts/smoke-a.ts <workspaceRoot> [baseBranch]
 */
import { dispatchNewThread, newId, type ModelSelection } from "../src/t3/client";
import { claudeModelSelection } from "../src/t3/model";
import { findProjectByWorkspaceRoot, threadInfo } from "../src/t3/state";
import { waitForTurnSettled } from "../src/t3/watch";

const workspaceRoot = process.argv[2];
const baseBranch = process.argv[3] ?? "main";
if (!workspaceRoot) {
  console.error("Usage: bun run server/scripts/smoke-a.ts <workspaceRoot> [baseBranch]");
  process.exit(1);
}

const project = findProjectByWorkspaceRoot(workspaceRoot);
if (!project) {
  console.error(`No T3 project registered for ${workspaceRoot}`);
  process.exit(1);
}

const threadId = newId();
const messageId = newId();
const branch = `ai-runner/smoke-${Date.now().toString(36)}`;
const modelSelection: ModelSelection = claudeModelSelection("claude-haiku-4-5");

const dispatchedAt = new Date().toISOString();
console.log(`Dispatching thread ${threadId} on branch ${branch} (project ${project.projectId})`);

await dispatchNewThread({
  threadId,
  projectId: project.projectId,
  title: "ai-runner smoke test (safe to delete)",
  branch,
  baseBranch,
  projectCwd: workspaceRoot,
  modelSelection,
  firstMessage:
    "Run `pwd` and `git rev-parse --abbrev-ref HEAD` and reply with both outputs verbatim. Do not modify any files, do not run any other commands.",
  messageId,
});

console.log("Dispatch accepted. Waiting for turn to settle (poll 3s)...");

const result = await waitForTurnSettled(threadId, dispatchedAt, messageId, {
  timeoutMs: 10 * 60 * 1000,
  onPoll: ({ activeTurns, elapsedMs }) => {
    if (elapsedMs % 15000 < 3000) console.log(`  ...${Math.round(elapsedMs / 1000)}s active=${activeTurns}`);
  },
});

console.log("Settle result:", JSON.stringify(result, null, 2));

const info = threadInfo(threadId);
console.log("Thread info:", JSON.stringify(info, null, 2));
console.log(`\nSMOKE A ${result.outcome === "completed" ? "PASS" : "FAIL"} — threadId=${threadId}`);
console.log(`Verify branch in T3 UI reply matches: ${branch}`);
