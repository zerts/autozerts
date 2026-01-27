/** LocalStorage task state types */

import type { JiraIssue } from "./jira";

// Orchestration params passed to the background no-view command via LocalStorage

export interface OrchestrationImplementParams {
  mode: "implement";
  issue: JiraIssue;
  repoName: string;
  branchName: string;
  baseBranch: string;
  userInstructions: string;
}

export interface OrchestrationPlanParams {
  mode: "plan";
  issue: JiraIssue;
  repoName: string;
  branchName: string;
  baseBranch: string;
  userInstructions: string;
}

export interface OrchestrationFeedbackParams {
  mode: "feedback";
  jiraKey: string;
  repoName: string;
  feedbackText: string;
  postAsComment: boolean;
}

export type OrchestrationParams =
  | OrchestrationImplementParams
  | OrchestrationPlanParams
  | OrchestrationFeedbackParams;

export type TaskStatus =
  | "initializing"
  | "worktree_created"
  | "dependencies_installed"
  | "planning"
  | "plan_complete"
  | "implementing"
  | "implementation_complete"
  | "pushing"
  | "pr_created"
  | "feedback_implementing"
  | "complete"
  | "error"
  | "cancelled";

export interface TaskState {
  taskId: string;
  jiraKey: string;
  jiraSummary: string;
  jiraUrl: string;
  repoName: string;
  branchName: string;
  worktreePath: string;
  baseBranch: string;
  status: TaskStatus;
  claudeSessionId?: string;
  prUrl?: string;
  prNumber?: number;
  error?: string;
  costUsd?: number;
  createdAt: number;
  updatedAt: number;
  progressLog: string[];
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  initializing: "Initializing",
  worktree_created: "Worktree Created",
  dependencies_installed: "Dependencies Installed",
  planning: "Planning",
  plan_complete: "Plan Complete",
  implementing: "Implementing",
  implementation_complete: "Implementation Complete",
  pushing: "Pushing",
  pr_created: "PR Created",
  feedback_implementing: "Implementing Feedback",
  complete: "Complete",
  error: "Error",
  cancelled: "Cancelled",
};
