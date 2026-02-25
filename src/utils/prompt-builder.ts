import type { LinearIssue } from "../types/linear";

interface PromptContext {
  issue: LinearIssue;
  descriptionMarkdown: string;
  userInstructions: string;
  repoName: string;
  baseBranch: string;
  figmaContext?: string;
}

function buildIssueHeader(ctx: PromptContext): string[] {
  const sections: string[] = [];

  sections.push(`# Task: ${ctx.issue.identifier} — ${ctx.issue.title}`);
  sections.push("");
  sections.push(`**Priority:** ${ctx.issue.priorityLabel}`);
  sections.push(`**Status:** ${ctx.issue.state.name}`);
  sections.push(`**Repository:** ${ctx.repoName}`);
  sections.push(`**Base branch:** ${ctx.baseBranch}`);
  sections.push("");

  // Linear description
  if (ctx.descriptionMarkdown) {
    sections.push("## Description");
    sections.push("");
    sections.push(ctx.descriptionMarkdown);
    sections.push("");
  }

  // Linear comments
  const comments = ctx.issue.comments?.nodes;
  if (comments && comments.length > 0) {
    sections.push("## Comments");
    sections.push("");
    for (const comment of comments) {
      const author = comment.user?.name ?? "Unknown";
      const date = new Date(comment.createdAt).toLocaleDateString();
      sections.push(`**${author}** (${date}):`);
      sections.push(comment.body);
      sections.push("");
    }
  }

  // Figma design context
  if (ctx.figmaContext) {
    sections.push(ctx.figmaContext);
    sections.push("");
  }

  // User instructions
  if (ctx.userInstructions.trim()) {
    sections.push("## Additional Instructions");
    sections.push("");
    sections.push(ctx.userInstructions.trim());
    sections.push("");
  }

  return sections;
}

/**
 * Build the main implementation prompt for Claude Code.
 */
export function buildImplementationPrompt(ctx: PromptContext): string {
  const sections = buildIssueHeader(ctx);

  sections.push("## Your Task");
  sections.push("");
  sections.push(
    "Implement the changes described above. Follow these guidelines:",
  );
  sections.push(
    "- Read and understand the existing codebase before making changes",
  );
  sections.push("- Follow the existing code style and conventions");
  sections.push("- Write clean, well-tested code");
  sections.push("- Before every commit, run `npx prettier --write` on all changed files");
  sections.push("- Make focused commits with clear messages");
  sections.push("- If tests exist, make sure they pass after your changes");
  sections.push("- Do not modify files unrelated to the task");
  sections.push("");

  return sections.join("\n");
}

/**
 * Build a plan-only prompt. Claude explores the codebase and writes an
 * implementation plan to the given file — no code changes allowed.
 */
export function buildPlanPrompt(
  ctx: PromptContext & { planFilePath: string },
): string {
  const sections = buildIssueHeader(ctx);

  sections.push("## Your Task — Plan Only");
  sections.push("");
  sections.push(
    "DO NOT implement any code changes. Instead, create a detailed implementation plan.",
  );
  sections.push("");
  sections.push("Follow these steps:");
  sections.push(
    "1. Explore and read the relevant parts of the codebase to understand the existing architecture, patterns, and conventions",
  );
  sections.push(
    "2. Identify all files that need to be created, modified, or deleted",
  );
  sections.push(
    "3. Outline the specific changes for each file (functions to add/modify, types to define, tests to write, etc.)",
  );
  sections.push(
    "4. Note any dependencies, edge cases, or risks",
  );
  sections.push(
    `5. Write the full plan to the file: \`${ctx.planFilePath}\``,
  );
  sections.push("");
  sections.push(
    "The plan should be detailed enough that a developer (or an AI in a follow-up session) can implement it without further exploration.",
  );
  sections.push("");

  return sections.join("\n");
}

/**
 * Build a prompt to update an existing plan based on feedback.
 */
export function buildPlanUpdatePrompt(
  ctx: PromptContext & { planFilePath: string; existingPlan: string },
): string {
  const sections = buildIssueHeader(ctx);

  sections.push("## Your Task — Update the Existing Plan");
  sections.push("");
  sections.push(
    "An implementation plan was created previously. Update it based on the additional instructions above.",
  );
  sections.push("");
  sections.push("### Current Plan");
  sections.push("");
  sections.push(ctx.existingPlan);
  sections.push("");
  sections.push("Follow these steps:");
  sections.push(
    "1. Review the current plan and the new feedback/instructions",
  );
  sections.push(
    "2. Explore the codebase if needed to address the feedback",
  );
  sections.push(
    "3. Update the plan to incorporate the changes",
  );
  sections.push(
    `4. Write the updated plan to: \`${ctx.planFilePath}\``,
  );
  sections.push("");

  return sections.join("\n");
}

/**
 * Build a feedback prompt for implementing PR review comments.
 */
export function buildFeedbackPrompt(params: {
  issueKey: string;
  prNumber: number;
  feedbackText: string;
  newCommentsContext?: string;
}): string {
  const sections: string[] = [];

  sections.push(`# Feedback for ${params.issueKey} (PR #${params.prNumber})`);
  sections.push("");

  if (params.newCommentsContext) {
    sections.push("## New Comments Since Last Commit");
    sections.push("");
    sections.push(params.newCommentsContext);
    sections.push("");
  }

  sections.push("## Reviewer Feedback");
  sections.push("");
  sections.push(params.feedbackText);
  sections.push("");
  sections.push("## Your Task");
  sections.push("");
  sections.push("Implement the changes requested in the feedback above.");
  if (params.newCommentsContext) {
    sections.push("- Address the new reviewer comments listed above");
  }
  sections.push("- Address each point in the feedback");
  sections.push("- Before every commit, run `npx prettier --write` on all changed files");
  sections.push("- Make focused commits with clear messages");
  sections.push("- If tests exist, make sure they pass after your changes");
  sections.push("");

  return sections.join("\n");
}
