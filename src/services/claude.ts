import { showToast, Toast } from "@raycast/api";
import {
  query,
  type SDKResultMessage,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { getConfig } from "../utils/preferences";
import { updateTaskStatus, appendProgressLog } from "../utils/storage";
import { createWorktree, installDependencies, commitAllChanges, pushBranch, getPlanFilePath, readPlanFile, ensurePlanFilesDir } from "./worktree";
import { createPullRequest, addPRComment } from "./github";
import { addComment as addJiraComment, issueUrl } from "./jira";
import {
  buildImplementationPrompt,
  buildPlanPrompt,
  buildFeedbackPrompt,
} from "../utils/prompt-builder";
import type { JiraIssue } from "../types/jira";
import type { RepoConfig } from "../types/preferences";
import type { TaskState } from "../types/storage";
import { adfToMarkdown } from "../utils/adf-to-markdown";

interface OrchestrateParams {
  issue: JiraIssue;
  repo: RepoConfig;
  branchName: string;
  baseBranch: string;
  userInstructions: string;
  abortController?: AbortController;
}

/**
 * Main orchestration: create worktree → install deps → run Claude → push → create PR.
 * Runs in the background (fire-and-forget from the UI).
 */
export async function orchestrateImplementation(
  params: OrchestrateParams,
): Promise<void> {
  const {
    issue,
    repo,
    branchName,
    baseBranch,
    userInstructions,
    abortController,
  } = params;
  const jiraKey = issue.key;
  const config = getConfig();

  const notify = (title: string, message?: string) =>
    showToast({ style: Toast.Style.Animated, title, message });

  try {
    // Step 1: Create worktree
    await notify(`${jiraKey}: Creating worktree`);
    await appendProgressLog(jiraKey, "Creating git worktree...");
    const worktreePath = await createWorktree({ repo, branchName, baseBranch });
    await updateTaskStatus(jiraKey, "worktree_created", { worktreePath });
    await appendProgressLog(jiraKey, `Worktree created at ${worktreePath}`);

    // Step 2: Install dependencies
    await notify(`${jiraKey}: Installing dependencies`);
    await appendProgressLog(jiraKey, "Installing dependencies...");
    await installDependencies(worktreePath);
    await updateTaskStatus(jiraKey, "dependencies_installed");
    await appendProgressLog(jiraKey, "Dependencies installed");

    // Step 3: Build prompt and run Claude
    await notify(`${jiraKey}: Claude is implementing`);
    await updateTaskStatus(jiraKey, "implementing");
    await appendProgressLog(jiraKey, "Starting Claude Code implementation...");

    // Check for an existing plan file and include it in the prompt
    const existingPlan = await readPlanFile(branchName);
    let extraInstructions = userInstructions;
    if (existingPlan) {
      await appendProgressLog(jiraKey, "Found existing plan file — including in prompt");
      extraInstructions =
        (userInstructions ? userInstructions + "\n\n" : "") +
        "## Implementation Plan\n\n" +
        "A plan was prepared in a prior session. Follow it closely:\n\n" +
        existingPlan;
    }

    const prompt = buildImplementationPrompt({
      issue,
      descriptionMarkdown: adfToMarkdown(issue.fields.description),
      userInstructions: extraInstructions,
      repoName: repo.name,
      baseBranch,
    });

    const result = await runClaude({
      prompt,
      cwd: worktreePath,
      abortController,
      onProgress: (entry) => appendProgressLog(jiraKey, entry),
    });

    // Store session ID for potential resume
    const costUsd = result.costUsd ?? 0;
    await updateTaskStatus(jiraKey, "implementation_complete", {
      claudeSessionId: result.sessionId,
      costUsd,
    });
    await appendProgressLog(
      jiraKey,
      `Implementation complete (cost: $${costUsd.toFixed(2)})`,
    );

    // Step 4: Commit any uncommitted changes, then push
    await notify(`${jiraKey}: Committing & pushing`);
    await updateTaskStatus(jiraKey, "pushing");
    const didCommit = await commitAllChanges(worktreePath);
    if (didCommit) {
      await appendProgressLog(jiraKey, "Committed remaining uncommitted changes");
    }
    await appendProgressLog(jiraKey, "Pushing branch to origin...");
    await pushBranch(worktreePath, branchName, repo.name);
    await appendProgressLog(jiraKey, "Branch pushed");

    // Step 5: Create PR
    await notify(`${jiraKey}: Creating pull request`);
    await appendProgressLog(jiraKey, "Creating pull request...");
    const descriptionMd = adfToMarkdown(issue.fields.description);
    const prBody = [
      `## ${jiraKey}: ${issue.fields.summary}`,
      "",
      descriptionMd ? descriptionMd.slice(0, 2000) : "",
      "",
      `[JIRA Ticket](${issueUrl(jiraKey)})`,
      "",
      "---",
      `*Implemented by Claude Code (cost: $${costUsd.toFixed(2)})*`,
    ].join("\n");

    const pr = await createPullRequest({
      owner: config.githubOwner,
      repo: repo.name,
      title: `${jiraKey}: ${issue.fields.summary}`,
      body: prBody,
      head: branchName,
      base: baseBranch,
    });

    await updateTaskStatus(jiraKey, "pr_created", {
      prUrl: pr.html_url,
      prNumber: pr.number,
    });
    await appendProgressLog(jiraKey, `PR created: ${pr.html_url}`);

    // Step 6: Add comment to JIRA
    try {
      await addJiraComment(jiraKey, `Pull request created: ${pr.html_url}`);
      await appendProgressLog(jiraKey, "JIRA comment added");
    } catch {
      await appendProgressLog(jiraKey, "Warning: Failed to add JIRA comment");
    }

    // Done
    await updateTaskStatus(jiraKey, "complete");
    await appendProgressLog(jiraKey, "Task complete!");

    await showToast({
      style: Toast.Style.Success,
      title: `${jiraKey}: PR Created`,
      message: pr.html_url,
    });
  } catch (error) {
    if (abortController?.signal.aborted) {
      await updateTaskStatus(jiraKey, "cancelled");
      await appendProgressLog(jiraKey, "Task cancelled by user");
      await showToast({
        style: Toast.Style.Failure,
        title: `${jiraKey}: Cancelled`,
      });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      await updateTaskStatus(jiraKey, "error", { error: message });
      await appendProgressLog(jiraKey, `Error: ${message}`);

      await showToast({
        style: Toast.Style.Failure,
        title: `${jiraKey}: Implementation Failed`,
        message,
      });
    }
  }
}

/**
 * Plan-only orchestration: create worktree → install deps → run Claude to
 * explore the codebase and produce a plan file. No code changes, no push.
 */
export async function orchestratePlan(
  params: OrchestrateParams,
): Promise<void> {
  const { issue, repo, branchName, baseBranch, userInstructions, abortController } = params;
  const jiraKey = issue.key;

  const notify = (title: string, message?: string) =>
    showToast({ style: Toast.Style.Animated, title, message });

  try {
    // Step 1: Create worktree
    await notify(`${jiraKey}: Creating worktree`);
    await appendProgressLog(jiraKey, "Creating git worktree...");
    const worktreePath = await createWorktree({ repo, branchName, baseBranch });
    await updateTaskStatus(jiraKey, "worktree_created", { worktreePath });
    await appendProgressLog(jiraKey, `Worktree created at ${worktreePath}`);

    // Step 2: Install dependencies
    await notify(`${jiraKey}: Installing dependencies`);
    await appendProgressLog(jiraKey, "Installing dependencies...");
    await installDependencies(worktreePath);
    await updateTaskStatus(jiraKey, "dependencies_installed");
    await appendProgressLog(jiraKey, "Dependencies installed");

    // Step 3: Run Claude in plan-only mode
    await notify(`${jiraKey}: Claude is planning`);
    await updateTaskStatus(jiraKey, "planning");
    await appendProgressLog(jiraKey, "Starting Claude Code planning session...");

    await ensurePlanFilesDir();
    const planFilePath = getPlanFilePath(branchName);

    const prompt = buildPlanPrompt({
      issue,
      descriptionMarkdown: adfToMarkdown(issue.fields.description),
      userInstructions,
      repoName: repo.name,
      baseBranch,
      planFilePath,
    });

    const result = await runClaude({
      prompt,
      cwd: worktreePath,
      abortController,
      onProgress: (entry) => appendProgressLog(jiraKey, entry),
    });

    const costUsd = result.costUsd ?? 0;
    await updateTaskStatus(jiraKey, "plan_complete", {
      claudeSessionId: result.sessionId,
      costUsd,
    });
    await appendProgressLog(
      jiraKey,
      `Plan complete (cost: $${costUsd.toFixed(2)}). Plan file: ${planFilePath}`,
    );

    await showToast({
      style: Toast.Style.Success,
      title: `${jiraKey}: Plan Ready`,
      message: "Review the plan, then launch implementation.",
    });
  } catch (error) {
    if (abortController?.signal.aborted) {
      await updateTaskStatus(jiraKey, "cancelled");
      await appendProgressLog(jiraKey, "Task cancelled by user");
      await showToast({
        style: Toast.Style.Failure,
        title: `${jiraKey}: Cancelled`,
      });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      await updateTaskStatus(jiraKey, "error", { error: message });
      await appendProgressLog(jiraKey, `Error: ${message}`);

      await showToast({
        style: Toast.Style.Failure,
        title: `${jiraKey}: Planning Failed`,
        message,
      });
    }
  }
}

/**
 * Run Claude Code on feedback for an existing PR.
 */
export async function orchestrateFeedback(params: {
  task: TaskState;
  repo: RepoConfig;
  feedbackText: string;
  postAsComment: boolean;
  abortController?: AbortController;
}): Promise<void> {
  const { task, repo, feedbackText, postAsComment, abortController } = params;
  const jiraKey = task.jiraKey;

  try {
    // Post comment to GitHub if requested
    if (postAsComment && task.prNumber) {
      await addPRComment(
        getConfig().githubOwner,
        repo.name,
        task.prNumber,
        feedbackText,
      );
      await appendProgressLog(jiraKey, "Feedback posted as GitHub comment");
    }

    // Ensure worktree exists
    let worktreePath = task.worktreePath;
    const fs = await import("fs/promises");
    try {
      await fs.access(worktreePath);
    } catch {
      // Recreate worktree
      await appendProgressLog(jiraKey, "Recreating worktree...");
      worktreePath = await createWorktree({
        repo,
        branchName: task.branchName,
        baseBranch: task.baseBranch,
      });
      await updateTaskStatus(jiraKey, "worktree_created", { worktreePath });
    }

    // Run Claude with feedback prompt
    await updateTaskStatus(jiraKey, "feedback_implementing");
    await appendProgressLog(jiraKey, "Starting Claude Code for feedback...");

    const prompt = buildFeedbackPrompt({
      jiraKey,
      prNumber: task.prNumber ?? 0,
      feedbackText,
    });

    const result = await runClaude({
      prompt,
      cwd: worktreePath,
      resumeSessionId: task.claudeSessionId,
      abortController,
      onProgress: (entry) => appendProgressLog(jiraKey, entry),
    });

    const costUsd = (task.costUsd ?? 0) + (result.costUsd ?? 0);
    await updateTaskStatus(jiraKey, "pushing", {
      costUsd,
      claudeSessionId: result.sessionId,
    });
    await appendProgressLog(jiraKey, "Feedback implemented, committing & pushing...");

    // Commit any uncommitted changes, then push (PR auto-updates)
    const didCommit = await commitAllChanges(worktreePath);
    if (didCommit) {
      await appendProgressLog(jiraKey, "Committed remaining uncommitted changes");
    }
    await pushBranch(worktreePath, task.branchName, repo.name);
    await updateTaskStatus(jiraKey, "complete");
    await appendProgressLog(jiraKey, "Feedback changes pushed");

    await showToast({
      style: Toast.Style.Success,
      title: "Feedback Implemented",
      message: `Changes pushed to ${task.branchName}`,
    });
  } catch (error) {
    if (abortController?.signal.aborted) {
      await updateTaskStatus(jiraKey, "cancelled");
      await appendProgressLog(jiraKey, "Task cancelled by user");
      await showToast({
        style: Toast.Style.Failure,
        title: "Feedback Cancelled",
        message: jiraKey,
      });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      await updateTaskStatus(jiraKey, "error", { error: message });
      await appendProgressLog(jiraKey, `Error: ${message}`);

      await showToast({
        style: Toast.Style.Failure,
        title: "Feedback Implementation Failed",
        message,
      });
    }
  }
}

interface RunClaudeParams {
  prompt: string;
  cwd: string;
  resumeSessionId?: string;
  abortController?: AbortController;
  onProgress?: (entry: string) => Promise<void>;
}

interface ClaudeResult {
  sessionId?: string;
  costUsd?: number;
}

async function runClaude(params: RunClaudeParams): Promise<ClaudeResult> {
  const config = getConfig();
  const { onProgress } = params;

  // Raycast bundles the extension with esbuild, which breaks the SDK's
  // internal resolution of its bundled cli.js. Point to the globally installed
  // CLI script directly. We also inject nvm's node into PATH so the
  // #!/usr/bin/env node shebang resolves correctly.
  const NVM_BIN = "/Users/zerts/.nvm/versions/node/v22.14.0/bin";
  const executablePath = `${NVM_BIN}/../lib/node_modules/@anthropic-ai/claude-code/cli.js`;

  const stderrChunks: string[] = [];

  // Raycast launches as a macOS app so its process may lack shell env vars
  // that the CLI needs (HOME for ~/.claude/ auth, USER, SHELL, etc.).
  // We also inject git identity env vars so commits use the bot identity
  // instead of the user's personal git config.
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: process.env.HOME ?? `/Users/${process.env.USER ?? "zerts"}`,
    USER: process.env.USER ?? "zerts",
    PATH: `${NVM_BIN}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    GIT_AUTHOR_NAME: config.gitAuthorName,
    GIT_AUTHOR_EMAIL: config.gitAuthorEmail,
    GIT_COMMITTER_NAME: config.gitAuthorName,
    GIT_COMMITTER_EMAIL: config.gitAuthorEmail,
  };

  const options: Parameters<typeof query>[0] = {
    prompt: params.prompt,
    options: {
      cwd: params.cwd,
      pathToClaudeCodeExecutable: executablePath,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      maxTurns: config.claudeMaxTurns,
      model: config.claudeModel,
      env,
      stderr: (data: string) => stderrChunks.push(data),
      ...(params.abortController ? { abortController: params.abortController } : {}),
      ...(params.resumeSessionId ? { resume: params.resumeSessionId } : {}),
    },
  };

  let sessionId: string | undefined;
  let costUsd = 0;

  try {
    for await (const message of query(options)) {
      await processSDKMessage(message, onProgress);

      if (message.type === "result") {
        const result = message as SDKResultMessage;
        sessionId = result.session_id;
        costUsd = result.total_cost_usd ?? 0;
        if (result.is_error && "errors" in result && result.errors?.length) {
          throw new Error(result.errors.join("\n"));
        }
      }
    }
  } catch (error) {
    const stderr = stderrChunks.join("").trim();
    const msg = error instanceof Error ? error.message : String(error);
    const diagnostics = [
      msg,
      stderr ? `\nstderr:\n${stderr}` : "",
      `\nenv.HOME=${env.HOME}`,
      `\ncli=${executablePath}`,
    ]
      .filter(Boolean)
      .join("");
    throw new Error(diagnostics);
  }

  return { sessionId, costUsd };
}

// ---------------------------------------------------------------------------
// SDK message → human-readable progress log entries
// ---------------------------------------------------------------------------

async function processSDKMessage(
  message: SDKMessage,
  onProgress?: (entry: string) => Promise<void>,
): Promise<void> {
  if (!onProgress) return;

  switch (message.type) {
    case "system": {
      if (message.subtype === "init") {
        const init = message as Extract<SDKMessage, { subtype: "init" }>;
        await onProgress(`[init] Session started — model: ${init.model}, tools: ${init.tools.length}`);
      }
      break;
    }

    case "assistant": {
      const content = (message as { message: { content: ContentBlock[] } })
        .message.content;
      for (const block of content) {
        if (block.type === "text" && block.text?.trim()) {
          const text = block.text.trim();
          // Show first 300 chars of Claude's text to keep log readable
          const truncated = text.length > 300 ? text.slice(0, 300) + "..." : text;
          await onProgress(`[claude] ${truncated}`);
        }
        if (block.type === "tool_use") {
          await onProgress(formatToolUse(block.name, block.input));
        }
      }
      break;
    }

    case "tool_use_summary": {
      const summary = (message as { summary: string }).summary;
      if (summary?.trim()) {
        await onProgress(`[summary] ${summary.trim()}`);
      }
      break;
    }

    case "result": {
      const result = message as SDKResultMessage;
      const status = result.is_error ? "error" : "success";
      await onProgress(
        `[result] ${status} — turns: ${result.num_turns}, cost: $${result.total_cost_usd?.toFixed(2) ?? "?"}`,
      );
      break;
    }

    default:
      break;
  }
}

/** Content block shape from the Anthropic API (not importing the type directly). */
interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}

function formatToolUse(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string {
  if (!input) return `[tool] ${toolName}`;

  switch (toolName) {
    case "Read":
      return `[read] ${input.file_path ?? ""}`;
    case "Edit":
      return `[edit] ${input.file_path ?? ""}`;
    case "Write":
      return `[write] ${input.file_path ?? ""}`;
    case "Bash": {
      const cmd = String(input.command ?? "").slice(0, 200);
      return `[bash] ${cmd}`;
    }
    case "Glob":
      return `[glob] ${input.pattern ?? ""} ${input.path ? `in ${input.path}` : ""}`.trim();
    case "Grep":
      return `[grep] ${input.pattern ?? ""} ${input.path ? `in ${input.path}` : ""}`.trim();
    case "Task":
      return `[task] ${input.description ?? input.prompt ?? "subagent"}`;
    case "TodoWrite":
      return `[todo] updating task list`;
    case "WebFetch":
      return `[fetch] ${input.url ?? ""}`;
    case "WebSearch":
      return `[search] ${input.query ?? ""}`;
    default:
      return `[tool] ${toolName}`;
  }
}
