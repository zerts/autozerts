import type { JiraIssue } from "../types/jira";
import { adfToMarkdown } from "./adf-to-markdown";

interface PromptContext {
  issue: JiraIssue;
  descriptionMarkdown: string;
  userInstructions: string;
  repoName: string;
  baseBranch: string;
}

/**
 * Build the main implementation prompt for Claude Code.
 */
export function buildImplementationPrompt(ctx: PromptContext): string {
  const sections: string[] = [];

  sections.push(`# Task: ${ctx.issue.key} — ${ctx.issue.fields.summary}`);
  sections.push("");
  sections.push(`**Type:** ${ctx.issue.fields.issuetype.name}`);
  sections.push(`**Priority:** ${ctx.issue.fields.priority.name}`);
  sections.push(`**Status:** ${ctx.issue.fields.status.name}`);
  sections.push(`**Repository:** ${ctx.repoName}`);
  sections.push(`**Base branch:** ${ctx.baseBranch}`);
  sections.push("");

  // JIRA description
  if (ctx.descriptionMarkdown) {
    sections.push("## JIRA Description");
    sections.push("");
    sections.push(ctx.descriptionMarkdown);
    sections.push("");
  }

  // JIRA comments
  const comments = ctx.issue.fields.comment?.comments;
  if (comments && comments.length > 0) {
    sections.push("## JIRA Comments");
    sections.push("");
    for (const comment of comments) {
      const author = comment.author.displayName;
      const date = new Date(comment.created).toLocaleDateString();
      const body = adfToMarkdown(comment.body);
      sections.push(`**${author}** (${date}):`);
      sections.push(body);
      sections.push("");
    }
  }

  // User instructions
  if (ctx.userInstructions.trim()) {
    sections.push("## Additional Instructions");
    sections.push("");
    sections.push(ctx.userInstructions.trim());
    sections.push("");
  }

  // Task instructions
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
  const sections: string[] = [];

  sections.push(`# Task: ${ctx.issue.key} — ${ctx.issue.fields.summary}`);
  sections.push("");
  sections.push(`**Type:** ${ctx.issue.fields.issuetype.name}`);
  sections.push(`**Priority:** ${ctx.issue.fields.priority.name}`);
  sections.push(`**Status:** ${ctx.issue.fields.status.name}`);
  sections.push(`**Repository:** ${ctx.repoName}`);
  sections.push(`**Base branch:** ${ctx.baseBranch}`);
  sections.push("");

  // JIRA description
  if (ctx.descriptionMarkdown) {
    sections.push("## JIRA Description");
    sections.push("");
    sections.push(ctx.descriptionMarkdown);
    sections.push("");
  }

  // JIRA comments
  const comments = ctx.issue.fields.comment?.comments;
  if (comments && comments.length > 0) {
    sections.push("## JIRA Comments");
    sections.push("");
    for (const comment of comments) {
      const author = comment.author.displayName;
      const date = new Date(comment.created).toLocaleDateString();
      const body = adfToMarkdown(comment.body);
      sections.push(`**${author}** (${date}):`);
      sections.push(body);
      sections.push("");
    }
  }

  // User instructions
  if (ctx.userInstructions.trim()) {
    sections.push("## Additional Instructions");
    sections.push("");
    sections.push(ctx.userInstructions.trim());
    sections.push("");
  }

  // Plan-mode instructions
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
 * Build a feedback prompt for implementing PR review comments.
 */
export function buildFeedbackPrompt(params: {
  jiraKey: string;
  prNumber: number;
  feedbackText: string;
}): string {
  const sections: string[] = [];

  sections.push(`# Feedback for ${params.jiraKey} (PR #${params.prNumber})`);
  sections.push("");
  sections.push("## Reviewer Feedback");
  sections.push("");
  sections.push(params.feedbackText);
  sections.push("");
  sections.push("## Your Task");
  sections.push("");
  sections.push("Implement the changes requested in the feedback above.");
  sections.push("- Address each point in the feedback");
  sections.push("- Make focused commits with clear messages");
  sections.push("- If tests exist, make sure they pass after your changes");
  sections.push("");

  return sections.join("\n");
}
