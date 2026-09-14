/** Composition of every turn the Runner dispatches. */
import type { LoopRow } from "../db";

export function firstMessage(loop: LoopRow): string {
  const skill = loop.force_grill ? "/grill-with-docs" : "/linear-implement";
  let text = `${skill} ${loop.issue_url}`;
  if (loop.extras) text += `\n\n${loop.extras}`;
  if (loop.autonomous) {
    text +=
      "\n\nDon't grill — make reasonable assumptions and record them in the PR description.";
  }
  return text;
}

export function reviewMessage(loop: LoopRow): string {
  let text = `/loop-review ${loop.issue_url} ${loop.pr_url}`;
  if (loop.round === "address-review") {
    text +=
      "\n\nThis round exists to address human PR review comments: the implementation turn ran /address-review over the human review threads (code changes or reasoned replies, threads resolved as it went). Read those threads — including resolved ones — and verify each was genuinely addressed at the current head.";
  }
  return text;
}

export function fixMessage(loop: LoopRow, reviewDoc: string): string {
  return [
    `The loop review (iteration ${loop.iteration}/${loop.max_iterations}) came back \`needs-changes\`.`,
    `Address every needs-changes finding below. When done, commit and push to \`${loop.task_branch}\`.`,
    "",
    "---",
    "",
    reviewDoc,
  ].join("\n");
}

export function qaMessage(loop: LoopRow): string {
  return `/loop-qa ${loop.issue_url} ${loop.pr_url}`;
}

export function qaFixMessage(loop: LoopRow, qaDoc: string, port = 3000): string {
  return [
    `The QA smoke gate (iteration ${loop.iteration}/${loop.max_iterations}) came back \`fail\` — the change does not boot or the affected flow doesn't render.`,
    `Fix the blocker(s) below so the app starts on port ${port} and the affected flow renders, then commit and push to \`${loop.task_branch}\`. (Code review runs only once QA passes.)`,
    "",
    "---",
    "",
    qaDoc,
  ].join("\n");
}

export function nudgePushMessage(loop: LoopRow): string {
  return `You haven't pushed — the remote head of \`${loop.task_branch}\` is unchanged. Commit your changes and push to \`${loop.task_branch}\` now. If you already committed, just push.`;
}

export const ADDRESS_REVIEW_MESSAGE = "/address-review";

export const COMPACT_MESSAGE = "/compact";
