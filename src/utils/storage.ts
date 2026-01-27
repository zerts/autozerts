import { LocalStorage } from "@raycast/api";
import type { TaskState, TaskStatus, OrchestrationParams } from "../types/storage";

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
        // Valid surrogate pair — keep both
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
const ORCH_PREFIX = "orch-params:";
const CANCEL_PREFIX = "cancel:";

export async function getTask(jiraKey: string): Promise<TaskState | null> {
  const raw = await LocalStorage.getItem<string>(`${TASK_PREFIX}${jiraKey}`);
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
    `${TASK_PREFIX}${task.jiraKey}`,
    JSON.stringify(task),
  );
}

export async function updateTaskStatus(
  jiraKey: string,
  status: TaskStatus,
  extra?: Partial<TaskState>,
): Promise<TaskState | null> {
  const task = await getTask(jiraKey);
  if (!task) return null;
  task.status = status;
  if (extra) Object.assign(task, extra);
  await saveTask(task);
  return task;
}

export async function appendProgressLog(
  jiraKey: string,
  message: string,
): Promise<void> {
  const task = await getTask(jiraKey);
  if (!task) return;
  task.progressLog.push(`[${new Date().toLocaleTimeString()}] ${sanitizeUnicode(message)}`);
  // Keep a generous limit — Claude sessions can produce hundreds of entries.
  // LocalStorage has a per-item size limit, so trim if needed.
  if (task.progressLog.length > 500) {
    task.progressLog = task.progressLog.slice(-500);
  }
  await saveTask(task);
}

export async function getAllTasks(): Promise<TaskState[]> {
  const allItems = await LocalStorage.allItems();
  const tasks: TaskState[] = [];
  for (const [key, value] of Object.entries(allItems)) {
    if (key.startsWith(TASK_PREFIX) && typeof value === "string") {
      try {
        tasks.push(JSON.parse(value) as TaskState);
      } catch {
        // skip corrupted entries
      }
    }
  }
  return tasks.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function removeTask(jiraKey: string): Promise<void> {
  await LocalStorage.removeItem(`${TASK_PREFIX}${jiraKey}`);
}

export function createInitialTaskState(params: {
  jiraKey: string;
  jiraSummary: string;
  jiraUrl: string;
  repoName: string;
  branchName: string;
  worktreePath: string;
  baseBranch: string;
}): TaskState {
  return {
    taskId: params.jiraKey,
    jiraKey: params.jiraKey,
    jiraSummary: params.jiraSummary,
    jiraUrl: params.jiraUrl,
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
// Orchestration params (passed to background command via LocalStorage)
// ---------------------------------------------------------------------------

export async function saveOrchestrationParams(
  jiraKey: string,
  params: OrchestrationParams,
): Promise<void> {
  await LocalStorage.setItem(
    `${ORCH_PREFIX}${jiraKey}`,
    JSON.stringify(params),
  );
}

export async function getOrchestrationParams(
  jiraKey: string,
): Promise<OrchestrationParams | null> {
  const raw = await LocalStorage.getItem<string>(`${ORCH_PREFIX}${jiraKey}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OrchestrationParams;
  } catch {
    return null;
  }
}

export async function clearOrchestrationParams(
  jiraKey: string,
): Promise<void> {
  await LocalStorage.removeItem(`${ORCH_PREFIX}${jiraKey}`);
}

// ---------------------------------------------------------------------------
// Cancellation flags
// ---------------------------------------------------------------------------

export async function requestCancellation(jiraKey: string): Promise<void> {
  await LocalStorage.setItem(`${CANCEL_PREFIX}${jiraKey}`, "true");
}

export async function isCancellationRequested(
  jiraKey: string,
): Promise<boolean> {
  const val = await LocalStorage.getItem<string>(`${CANCEL_PREFIX}${jiraKey}`);
  return val === "true";
}

export async function clearCancellation(jiraKey: string): Promise<void> {
  await LocalStorage.removeItem(`${CANCEL_PREFIX}${jiraKey}`);
}
