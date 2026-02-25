import { showToast, Toast } from "@raycast/api";
import {
  query,
  type SDKResultMessage,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { getConfig } from "../utils/preferences";
import { NODE_BIN_PATH } from "../config";
import { updateTaskStatus, appendProgressLog } from "../utils/storage";
import {
  createWorktree,
  installDependencies,
  commitAllChanges,
  pushBranch,
  pullBranch,
  getPlanFilePath,
  readPlanFile,
  ensurePlanFilesDir,
} from "./worktree";
import {
  createPullRequest,
  addPRComment,
  fetchPullRequest,
  fetchPRCommits,
  getLastCommitDate,
  markNewCommentsAsAddressed,
} from "./github";
import { addComment as addLinearComment, transitionIssue } from "./linear";
import {
  buildImplementationPrompt,
  buildPlanPrompt,
  buildPlanUpdatePrompt,
  buildFeedbackPrompt,
} from "../utils/prompt-builder";
import type { LinearIssue } from "../types/linear";
import type { RepoConfig } from "../types/preferences";
import type { TaskState } from "../types/storage";

/** showToast silently fails in background no-view commands — guard every call. */
async function safeShowToast(options: Toast.Options): Promise<void> {
  try {
    await showToast(options);
  } catch {
    // Toast API unavailable in background mode — ignore
  }
}

interface OrchestrateParams {
  issue: LinearIssue;
  repo: RepoConfig;
  branchName: string;
  baseBranch: string;
  userInstructions: string;
  abortController?: AbortController;
  updateExistingPlan?: boolean;
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
  const issueKey = issue.identifier;
  const config = getConfig();

  const notify = (title: string, message?: string) =>
    safeShowToast({ style: Toast.Style.Animated, title, message });

  try {
    // Step 1: Create worktree
    await notify(`${issueKey}: Creating worktree`);
    await appendProgressLog(issueKey, "Creating git worktree...");
    const worktreePath = await createWorktree({ repo, branchName, baseBranch });
    await updateTaskStatus(issueKey, "worktree_created", { worktreePath });
    await appendProgressLog(issueKey, `Worktree created at ${worktreePath}`);

    // Move Linear issue to In Progress
    try {
      await transitionIssue(issue.id, "In Progress");
      await appendProgressLog(issueKey, "Linear issue moved to In Progress");
    } catch {
      await appendProgressLog(
        issueKey,
        "Warning: Failed to transition Linear issue to In Progress",
      );
    }

    // Attach extra context to Linear as a comment
    if (userInstructions.trim()) {
      try {
        await addLinearComment(
          issue.id,
          `**Claude Code — Extra Context:**\n\n${userInstructions.trim()}`,
        );
        await appendProgressLog(issueKey, "Extra context posted to Linear");
      } catch {
        await appendProgressLog(
          issueKey,
          "Warning: Failed to post extra context to Linear",
        );
      }
    }

    // Step 2: Install dependencies
    await notify(`${issueKey}: Installing dependencies`);
    await appendProgressLog(issueKey, "Installing dependencies...");
    await installDependencies(worktreePath);
    await updateTaskStatus(issueKey, "dependencies_installed");
    await appendProgressLog(issueKey, "Dependencies installed");

    // Step 3: Fetch Figma design context (if configured)
    let figmaContext = "";
    try {
      const figmaDesigns = await fetchFigmaContext(issue);
      if (figmaDesigns.length > 0) {
        figmaContext = buildFigmaPromptSection(figmaDesigns);
        await appendProgressLog(
          issueKey,
          `Found ${figmaDesigns.length} Figma design reference(s)`,
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await appendProgressLog(
        issueKey,
        `Warning: Figma fetch failed (${msg}). Continuing without design context.`,
      );
    }

    // Step 4: Build prompt and run Claude
    await notify(`${issueKey}: Claude is implementing`);
    await updateTaskStatus(issueKey, "implementing");
    await appendProgressLog(issueKey, "Starting Claude Code implementation...");

    // Check for an existing plan file and include it in the prompt
    const existingPlan = await readPlanFile(branchName);
    let extraInstructions = userInstructions;
    if (existingPlan) {
      await appendProgressLog(
        issueKey,
        "Found existing plan file — including in prompt",
      );
      extraInstructions =
        (userInstructions ? userInstructions + "\n\n" : "") +
        "## Implementation Plan\n\n" +
        "A plan was prepared in a prior session. Follow it closely:\n\n" +
        existingPlan;
    }

    const prompt = buildImplementationPrompt({
      issue,
      descriptionMarkdown: issue.description ?? "",
      userInstructions: extraInstructions,
      repoName: repo.name,
      baseBranch,
      figmaContext,
    });

    const result = await runClaude({
      prompt,
      cwd: worktreePath,
      abortController,
      onProgress: (entry) => appendProgressLog(issueKey, entry),
    });

    // Store session ID for potential resume
    const costUsd = result.costUsd ?? 0;
    await updateTaskStatus(issueKey, "implementation_complete", {
      claudeSessionId: result.sessionId,
      costUsd,
    });
    await appendProgressLog(
      issueKey,
      `Implementation complete (cost: $${costUsd.toFixed(2)})`,
    );

    // Step 4: Commit any uncommitted changes, then push
    await notify(`${issueKey}: Committing & pushing`);
    await updateTaskStatus(issueKey, "pushing");
    const didCommit = await commitAllChanges(worktreePath);
    if (didCommit) {
      await appendProgressLog(
        issueKey,
        "Committed remaining uncommitted changes",
      );
    }
    await appendProgressLog(issueKey, "Pushing branch to origin...");
    await pushBranch(worktreePath, branchName, repo.name);
    await appendProgressLog(issueKey, "Branch pushed");

    // Step 5: Create PR
    await notify(`${issueKey}: Creating pull request`);
    await appendProgressLog(issueKey, "Creating pull request...");
    const prBody = [
      `## ${issueKey}: ${issue.title}`,
      "",
      issue.description ? issue.description.slice(0, 2000) : "",
      "",
      `[Linear Issue](${issue.url})`,
      "",
      "---",
      `*Implemented by Claude Code (cost: $${costUsd.toFixed(2)})*`,
    ].join("\n");

    const pr = await createPullRequest({
      owner: config.githubOwner,
      repo: repo.name,
      title: `${issueKey}: ${issue.title}`,
      body: prBody,
      head: branchName,
      base: baseBranch,
      labels: ["auto"],
    });

    await updateTaskStatus(issueKey, "pr_created", {
      prUrl: pr.html_url,
      prNumber: pr.number,
    });
    await appendProgressLog(issueKey, `PR created: ${pr.html_url}`);

    // Move Linear issue to In Review
    try {
      await transitionIssue(issue.id, "In Review");
      await appendProgressLog(issueKey, "Linear issue moved to In Review");
    } catch {
      await appendProgressLog(
        issueKey,
        "Warning: Failed to transition Linear issue to In Review",
      );
    }

    // Step 6: Add comment to Linear
    try {
      await addLinearComment(issue.id, `Pull request created: ${pr.html_url}`);
      await appendProgressLog(issueKey, "Linear comment added");
    } catch {
      await appendProgressLog(
        issueKey,
        "Warning: Failed to add Linear comment",
      );
    }

    // Done
    await updateTaskStatus(issueKey, "complete");
    await appendProgressLog(issueKey, "Task complete!");

    await safeShowToast({
      style: Toast.Style.Success,
      title: `${issueKey}: PR Created`,
      message: pr.html_url,
    });
  } catch (error) {
    if (abortController?.signal.aborted) {
      await updateTaskStatus(issueKey, "cancelled");
      await appendProgressLog(issueKey, "Task cancelled by user");
      await safeShowToast({
        style: Toast.Style.Failure,
        title: `${issueKey}: Cancelled`,
      });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      await updateTaskStatus(issueKey, "error", { error: message });
      await appendProgressLog(issueKey, `Error: ${message}`);

      await safeShowToast({
        style: Toast.Style.Failure,
        title: `${issueKey}: Implementation Failed`,
        message,
      });
    }
  } finally {
    await cleanupFigmaImages(issueKey);
  }
}

/**
 * Plan-only orchestration: create worktree → install deps → run Claude to
 * explore the codebase and produce a plan file. No code changes, no push.
 */
export async function orchestratePlan(
  params: OrchestrateParams,
): Promise<void> {
  const {
    issue,
    repo,
    branchName,
    baseBranch,
    userInstructions,
    abortController,
    updateExistingPlan,
  } = params;
  const issueKey = issue.identifier;

  const notify = (title: string, message?: string) =>
    safeShowToast({ style: Toast.Style.Animated, title, message });

  try {
    // Step 1: Create worktree
    await notify(`${issueKey}: Creating worktree`);
    await appendProgressLog(issueKey, "Creating git worktree...");
    const worktreePath = await createWorktree({ repo, branchName, baseBranch });
    await updateTaskStatus(issueKey, "worktree_created", { worktreePath });
    await appendProgressLog(issueKey, `Worktree created at ${worktreePath}`);

    // Move Linear issue to In Progress
    try {
      await transitionIssue(issue.id, "In Progress");
      await appendProgressLog(issueKey, "Linear issue moved to In Progress");
    } catch {
      await appendProgressLog(
        issueKey,
        "Warning: Failed to transition Linear issue to In Progress",
      );
    }

    // Attach extra context to Linear as a comment
    if (userInstructions.trim()) {
      try {
        await addLinearComment(
          issue.id,
          `**Claude Code — Extra Context:**\n\n${userInstructions.trim()}`,
        );
        await appendProgressLog(issueKey, "Extra context posted to Linear");
      } catch {
        await appendProgressLog(
          issueKey,
          "Warning: Failed to post extra context to Linear",
        );
      }
    }

    // Step 2: Install dependencies
    await notify(`${issueKey}: Installing dependencies`);
    await appendProgressLog(issueKey, "Installing dependencies...");
    await installDependencies(worktreePath);
    await updateTaskStatus(issueKey, "dependencies_installed");
    await appendProgressLog(issueKey, "Dependencies installed");

    // Step 3: Fetch Figma design context (if configured)
    let figmaContext = "";
    try {
      const figmaDesigns = await fetchFigmaContext(issue);
      if (figmaDesigns.length > 0) {
        figmaContext = buildFigmaPromptSection(figmaDesigns);
        await appendProgressLog(
          issueKey,
          `Found ${figmaDesigns.length} Figma design reference(s)`,
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await appendProgressLog(
        issueKey,
        `Warning: Figma fetch failed (${msg}). Continuing without design context.`,
      );
    }

    // Step 4: Run Claude in plan-only mode
    await notify(`${issueKey}: Claude is planning`);
    await updateTaskStatus(issueKey, "planning");

    await ensurePlanFilesDir();
    const planFilePath = getPlanFilePath(branchName);

    let prompt: string;
    if (updateExistingPlan) {
      const existingPlan = await readPlanFile(branchName);
      if (existingPlan) {
        await appendProgressLog(
          issueKey,
          "Updating existing plan based on feedback...",
        );
        prompt = buildPlanUpdatePrompt({
          issue,
          descriptionMarkdown: issue.description ?? "",
          userInstructions,
          repoName: repo.name,
          baseBranch,
          planFilePath,
          existingPlan,
          figmaContext,
        });
      } else {
        await appendProgressLog(
          issueKey,
          "No existing plan found, creating new plan...",
        );
        prompt = buildPlanPrompt({
          issue,
          descriptionMarkdown: issue.description ?? "",
          userInstructions,
          repoName: repo.name,
          baseBranch,
          planFilePath,
          figmaContext,
        });
      }
    } else {
      await appendProgressLog(
        issueKey,
        "Starting Claude Code planning session...",
      );
      prompt = buildPlanPrompt({
        issue,
        descriptionMarkdown: issue.description ?? "",
        userInstructions,
        repoName: repo.name,
        baseBranch,
        planFilePath,
        figmaContext,
      });
    }

    const result = await runClaude({
      prompt,
      cwd: worktreePath,
      abortController,
      onProgress: (entry) => appendProgressLog(issueKey, entry),
    });

    const costUsd = result.costUsd ?? 0;
    await updateTaskStatus(issueKey, "plan_complete", {
      claudeSessionId: result.sessionId,
      costUsd,
    });
    await appendProgressLog(
      issueKey,
      `Plan complete (cost: $${costUsd.toFixed(2)}). Plan file: ${planFilePath}`,
    );

    await safeShowToast({
      style: Toast.Style.Success,
      title: `${issueKey}: Plan Ready`,
      message: "Review the plan, then launch implementation.",
    });
  } catch (error) {
    if (abortController?.signal.aborted) {
      await updateTaskStatus(issueKey, "cancelled");
      await appendProgressLog(issueKey, "Task cancelled by user");
      await safeShowToast({
        style: Toast.Style.Failure,
        title: `${issueKey}: Cancelled`,
      });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      await updateTaskStatus(issueKey, "error", { error: message });
      await appendProgressLog(issueKey, `Error: ${message}`);

      await safeShowToast({
        style: Toast.Style.Failure,
        title: `${issueKey}: Planning Failed`,
        message,
      });
    }
  } finally {
    await cleanupFigmaImages(issueKey);
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
  newCommentsContext?: string;
  abortController?: AbortController;
}): Promise<void> {
  const {
    task,
    repo,
    feedbackText,
    postAsComment,
    newCommentsContext,
    abortController,
  } = params;
  const issueKey = task.issueKey;

  try {
    // Post comment to GitHub if requested
    if (postAsComment && feedbackText.trim().length > 0 && task.prNumber) {
      await addPRComment(
        getConfig().githubOwner,
        repo.name,
        task.prNumber,
        feedbackText,
      );
      await appendProgressLog(issueKey, "Feedback posted as GitHub comment");
    }

    // Ensure worktree exists
    let worktreePath = task.worktreePath;
    const fs = await import("fs/promises");
    try {
      await fs.access(worktreePath);
    } catch {
      // Recreate worktree
      await appendProgressLog(issueKey, "Recreating worktree...");
      worktreePath = await createWorktree({
        repo,
        branchName: task.branchName,
        baseBranch: task.baseBranch,
      });
      await updateTaskStatus(issueKey, "worktree_created", { worktreePath });
    }

    // Commit any uncommitted local changes first
    const hadLocalChanges = await commitAllChanges(worktreePath);
    if (hadLocalChanges) {
      await appendProgressLog(issueKey, "Committed uncommitted local changes");
    }

    // Pull latest changes from origin (with rebase)
    await appendProgressLog(issueKey, "Pulling latest changes from origin...");
    try {
      await pullBranch(worktreePath, task.branchName, repo.name);
      await appendProgressLog(issueKey, "Branch synced with origin");
    } catch (pullError) {
      const msg =
        pullError instanceof Error ? pullError.message : String(pullError);
      await appendProgressLog(
        issueKey,
        `Warning: Pull failed (${msg}). Continuing with local state.`,
      );
    }

    // Capture the last commit date before Claude makes changes (for marking comments later)
    let commentCutoffDate: string | null = null;
    let prAuthor: string | null = null;
    if (task.prNumber) {
      try {
        const config = getConfig();
        const [pr, commits] = await Promise.all([
          fetchPullRequest(config.githubOwner, repo.name, task.prNumber),
          fetchPRCommits(config.githubOwner, repo.name, task.prNumber),
        ]);
        prAuthor = pr.user.login;
        commentCutoffDate = getLastCommitDate(commits);
      } catch {
        // Ignore - we'll skip marking comments
      }
    }

    // Run Claude with feedback prompt
    await updateTaskStatus(issueKey, "feedback_implementing");
    await appendProgressLog(issueKey, "Starting Claude Code for feedback...");

    const prompt = buildFeedbackPrompt({
      issueKey,
      prNumber: task.prNumber ?? 0,
      feedbackText,
      newCommentsContext,
    });

    const result = await runClaude({
      prompt,
      cwd: worktreePath,
      resumeSessionId: task.claudeSessionId,
      abortController,
      onProgress: (entry) => appendProgressLog(issueKey, entry),
    });

    const costUsd = (task.costUsd ?? 0) + (result.costUsd ?? 0);
    await updateTaskStatus(issueKey, "pushing", {
      costUsd,
      claudeSessionId: result.sessionId,
    });
    await appendProgressLog(
      issueKey,
      "Feedback implemented, committing & pushing...",
    );

    // Commit any uncommitted changes, then push (PR auto-updates)
    const didCommit = await commitAllChanges(worktreePath);
    if (didCommit) {
      await appendProgressLog(
        issueKey,
        "Committed remaining uncommitted changes",
      );
    }
    await pushBranch(worktreePath, task.branchName, repo.name);
    await appendProgressLog(issueKey, "Feedback changes pushed");

    // Mark addressed comments with a reaction
    if (task.prNumber && prAuthor && commentCutoffDate) {
      try {
        const config = getConfig();
        const markedCount = await markNewCommentsAsAddressed(
          config.githubOwner,
          repo.name,
          task.prNumber,
          prAuthor,
          commentCutoffDate,
        );
        if (markedCount > 0) {
          await appendProgressLog(
            issueKey,
            `Marked ${markedCount} comment(s) as addressed`,
          );
        }
      } catch {
        await appendProgressLog(
          issueKey,
          "Warning: Could not mark comments as addressed",
        );
      }
    }

    await updateTaskStatus(issueKey, "complete");

    await safeShowToast({
      style: Toast.Style.Success,
      title: "Feedback Implemented",
      message: `Changes pushed to ${task.branchName}`,
    });
  } catch (error) {
    if (abortController?.signal.aborted) {
      await updateTaskStatus(issueKey, "cancelled");
      await appendProgressLog(issueKey, "Task cancelled by user");
      await safeShowToast({
        style: Toast.Style.Failure,
        title: "Feedback Cancelled",
        message: issueKey,
      });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      await updateTaskStatus(issueKey, "error", { error: message });
      await appendProgressLog(issueKey, `Error: ${message}`);

      await safeShowToast({
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
  const NVM_BIN = NODE_BIN_PATH;
  const executablePath = `${NVM_BIN}/../lib/node_modules/@anthropic-ai/claude-code/cli.js`;

  const stderrChunks: string[] = [];

  // Raycast launches as a macOS app so its process may lack shell env vars
  // that the CLI needs (HOME for ~/.claude/ auth, USER, SHELL, etc.).
  // We also inject git identity env vars so commits use the bot identity
  // instead of the user's personal git config.
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: process.env.HOME ?? `/Users/${process.env.USER}`,
    USER: process.env.USER,
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
      ...(params.abortController
        ? { abortController: params.abortController }
        : {}),
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
        await onProgress(
          `[init] Session started — model: ${init.model}, tools: ${init.tools.length}`,
        );
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
          const truncated =
            text.length > 300 ? text.slice(0, 300) + "..." : text;
          await onProgress(`[claude] ${truncated}`);
        }
        if (block.type === "tool_use" && block.name) {
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

// ---------------------------------------------------------------------------
// Figma design context helpers (stub — no Figma integration configured yet)
// ---------------------------------------------------------------------------

interface FigmaDesign {
  url: string;
  name: string;
  imageBase64: string;
}

async function fetchFigmaContext(_issue: LinearIssue): Promise<FigmaDesign[]> {
  // TODO: implement Figma API integration when needed
  return [];
}

function buildFigmaPromptSection(designs: FigmaDesign[]): string {
  if (designs.length === 0) return "";
  const lines = ["## Figma Designs", ""];
  for (const d of designs) {
    lines.push(`### ${d.name}`);
    lines.push(`URL: ${d.url}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function cleanupFigmaImages(_issueKey: string): Promise<void> {
  // no-op until Figma integration is implemented
}

// ---------------------------------------------------------------------------

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
