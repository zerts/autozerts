/**
 * Task-state storage backed by Raycast LocalStorage.
 * All functions are async and safe to call from both view and no-view commands.
 */
import { LocalStorage } from "@raycast/api";
import fs from "fs";
import path from "path";
import type {
  TaskState,
  TaskStatus,
  OrchestrationParams,
} from "../types/storage";

/**
 * Replace unpaired Unicode surrogates with U+FFFD (replacement character).
 * Unpaired surrogates break JSON serialization and Raycast's render tree parser.
 */
export function sanitizeUnicode(str: string): string {
  let result = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += str[i] + str[i + 1];
        i++;
      } else {
        result += "\uFFFD";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\uFFFD";
    } else {
      result += str[i];
    }
  }
  return result;
}

const TASK_PREFIX = "task:";
const ORCH_PREFIX = "orch:";
const CANCEL_PREFIX = "cancel:";

export async function getTask(issueKey: string): Promise<TaskState | null> {
  const raw = await LocalStorage.getItem<string>(`${TASK_PREFIX}${issueKey}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TaskState;
  } catch {
    return null;
  }
}

export async function saveTask(task: TaskState): Promise<void> {
  task.updatedAt = Date.now();
  await LocalStorage.setItem(
    `${TASK_PREFIX}${task.issueKey}`,
    JSON.stringify(task),
  );
}

export async function updateTaskStatus(
  issueKey: string,
  status: TaskStatus,
  extra?: Partial<TaskState>,
): Promise<TaskState | null> {
  const task = await getTask(issueKey);
  if (!task) return null;
  task.status = status;
  if (extra) Object.assign(task, extra);
  await saveTask(task);

  if (status === "complete" || status === "error") {
    await saveTaskLogFile(task);
  }

  return task;
}

export async function appendProgressLog(
  issueKey: string,
  message: string,
): Promise<void> {
  const task = await getTask(issueKey);
  if (!task) return;
  task.progressLog.push(
    `[${new Date().toLocaleTimeString()}] ${sanitizeUnicode(message)}`,
  );
  if (task.progressLog.length > 500) {
    task.progressLog = task.progressLog.slice(-500);
  }
  await saveTask(task);
}

export async function getAllTasks(): Promise<TaskState[]> {
  const all = await LocalStorage.allItems();
  const tasks: TaskState[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(TASK_PREFIX)) {
      try {
        tasks.push(JSON.parse(value as string) as TaskState);
      } catch {
        // skip malformed entries
      }
    }
  }
  return tasks;
}

export async function removeTask(issueKey: string): Promise<void> {
  await LocalStorage.removeItem(`${TASK_PREFIX}${issueKey}`);
}

export function createInitialTaskState(params: {
  issueKey: string;
  issueSummary: string;
  issueUrl: string;
  repoName: string;
  branchName: string;
  worktreePath: string;
  baseBranch: string;
}): TaskState {
  return {
    taskId: params.issueKey,
    issueKey: params.issueKey,
    issueSummary: params.issueSummary,
    issueUrl: params.issueUrl,
    repoName: params.repoName,
    branchName: params.branchName,
    worktreePath: params.worktreePath,
    baseBranch: params.baseBranch,
    status: "initializing",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    progressLog: [],
  };
}

// ---------------------------------------------------------------------------
// Orchestration params
// ---------------------------------------------------------------------------

export async function saveOrchestrationParams(
  issueKey: string,
  params: OrchestrationParams,
): Promise<void> {
  await LocalStorage.setItem(
    `${ORCH_PREFIX}${issueKey}`,
    JSON.stringify(params),
  );
}

export async function getOrchestrationParams(
  issueKey: string,
): Promise<OrchestrationParams | null> {
  const raw = await LocalStorage.getItem<string>(`${ORCH_PREFIX}${issueKey}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OrchestrationParams;
  } catch {
    return null;
  }
}

export async function clearOrchestrationParams(
  issueKey: string,
): Promise<void> {
  await LocalStorage.removeItem(`${ORCH_PREFIX}${issueKey}`);
}

// ---------------------------------------------------------------------------
// Cancellation flags
// ---------------------------------------------------------------------------

export async function requestCancellation(issueKey: string): Promise<void> {
  await LocalStorage.setItem(`${CANCEL_PREFIX}${issueKey}`, "1");
}

export async function isCancellationRequested(
  issueKey: string,
): Promise<boolean> {
  const val = await LocalStorage.getItem<string>(`${CANCEL_PREFIX}${issueKey}`);
  return val === "1";
}

export async function clearCancellation(issueKey: string): Promise<void> {
  await LocalStorage.removeItem(`${CANCEL_PREFIX}${issueKey}`);
}

// ---------------------------------------------------------------------------
// Log file persistence
// ---------------------------------------------------------------------------

async function saveTaskLogFile(task: TaskState): Promise<void> {
  const { getConfig } = await import("./preferences");
  const logFilesPath = getConfig().logFilesPath;
  if (!logFilesPath) return;

  try {
    if (!fs.existsSync(logFilesPath)) {
      fs.mkdirSync(logFilesPath, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${task.issueKey}_${timestamp}.log`;
    const filepath = path.join(logFilesPath, filename);

    const header = [
      `Task: ${task.issueKey}`,
      `Summary: ${task.issueSummary}`,
      `Repository: ${task.repoName}`,
      `Branch: ${task.branchName}`,
      `Status: ${task.status}`,
      `Created: ${new Date(task.createdAt).toISOString()}`,
      `Updated: ${new Date(task.updatedAt).toISOString()}`,
      task.prUrl ? `PR: ${task.prUrl}` : null,
      task.costUsd !== undefined ? `Cost: $${task.costUsd.toFixed(2)}` : null,
      task.error ? `Error: ${task.error}` : null,
      "",
      "=".repeat(80),
      "Progress Log:",
      "=".repeat(80),
      "",
    ]
      .filter(Boolean)
      .join("\n");

    const logContent = header + task.progressLog.join("\n");
    fs.writeFileSync(filepath, logContent, "utf-8");
  } catch {
    // Silently ignore file write errors
  }
}
