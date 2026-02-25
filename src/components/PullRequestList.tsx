import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
} from "@raycast/api";
import { useState, useEffect } from "react";
import { usePromise } from "@raycast/utils";
import {
  fetchMyOpenPRs,
  // fetchCheckRuns,
  fetchReviews,
  fetchPRComments,
  fetchReviewComments,
  fetchPRCommits,
  getLastCommitDate,
  isBotUser,
} from "../services/github";
import { getAllTasks } from "../utils/storage";
import { getConfig } from "../utils/preferences";
import { getPlanFilePath } from "../services/worktree";
import { REPOS } from "../config";
import type {
  GitHubPullRequest,
  GitHubReview,
  GitHubComment,
} from "../types/github";
import type { TaskState } from "../types/storage";
import { TASK_STATUS_LABELS } from "../types/storage";
import { PullRequestDetail } from "./PullRequestDetail";
import { ExecutionProgress } from "./ExecutionProgress";
import { PlanFeedbackForm } from "./PlanFeedbackForm";

/** Non-terminal statuses that mean a task is actively running. */
const ACTIVE_STATUSES = new Set([
  "initializing",
  "worktree_created",
  "dependencies_installed",
  "implementing",
  "implementation_complete",
  "pushing",
  "pr_created",
  "feedback_implementing",
]);

function taskStatusIcon(status: string): { source: Icon; tintColor: Color } {
  if (ACTIVE_STATUSES.has(status)) {
    return { source: Icon.CircleProgress, tintColor: Color.Orange };
  }
  switch (status) {
    case "complete":
      return { source: Icon.Checkmark, tintColor: Color.Green };
    case "plan_complete":
      return { source: Icon.Document, tintColor: Color.Blue };
    case "error":
      return { source: Icon.XMarkCircle, tintColor: Color.Red };
    case "cancelled":
      return { source: Icon.MinusCircle, tintColor: Color.SecondaryText };
    default:
      return { source: Icon.CircleProgress, tintColor: Color.Orange };
  }
}

interface EnrichedPR {
  pr: GitHubPullRequest;
  taskState?: TaskState;
  reviewState: "approved" | "changes_requested" | "pending" | "none";
  checksStatus: "success" | "failure" | "pending" | "none";
  newCommentCount: number;
  lastCommitDate: string | null;
  planExists: boolean;
  previewUrl: string | null;
  qaCheckedOut: boolean;
  qaUnpulledCount: number;
}

function reviewIcon(
  state: EnrichedPR["reviewState"],
): { source: Icon; tintColor: Color } | null {
  switch (state) {
    case "approved":
      return { source: Icon.Checkmark, tintColor: Color.Green };
    case "changes_requested":
      return { source: Icon.ExclamationMark, tintColor: Color.Red };
    case "pending":
      return { source: Icon.Eye, tintColor: Color.Yellow };
    default:
      return null;
  }
}

function reviewTooltip(state: EnrichedPR["reviewState"]): string {
  switch (state) {
    case "approved":
      return "Approved";
    case "changes_requested":
      return "Changes Requested";
    case "pending":
      return "Review Pending";
    default:
      return "";
  }
}

function checksIcon(
  status: EnrichedPR["checksStatus"],
): { source: Icon; tintColor: Color } | null {
  switch (status) {
    case "success":
      return { source: Icon.CheckCircle, tintColor: Color.Green };
    case "failure":
      return { source: Icon.XMarkCircle, tintColor: Color.Red };
    case "pending":
      return { source: Icon.CircleProgress, tintColor: Color.Yellow };
    default:
      return null;
  }
}

function checksTooltip(status: EnrichedPR["checksStatus"]): string {
  switch (status) {
    case "success":
      return "Checks Pass";
    case "failure":
      return "Checks Fail";
    case "pending":
      return "Checks Running";
    default:
      return "";
  }
}

function hexToRaycastColor(hex: string): Color {
  // Map common GitHub label colors to Raycast colors
  const h = hex.toLowerCase();
  if (["d73a4a", "b60205", "e11d48"].includes(h)) return Color.Red;
  if (["0075ca", "0969da", "1d76db"].includes(h)) return Color.Blue;
  if (["008672", "0e8a16", "22863a"].includes(h)) return Color.Green;
  if (["e4e669", "fbca04", "f9d0c4"].includes(h)) return Color.Yellow;
  if (["d876e3", "7057ff", "6f42c1"].includes(h)) return Color.Purple;
  if (["f28c18", "e99695", "ff7a00"].includes(h)) return Color.Orange;
  return Color.SecondaryText;
}

function deriveReviewState(reviews: GitHubReview[]): EnrichedPR["reviewState"] {
  if (reviews.length === 0) return "pending";
  // Use the most recent non-comment review per reviewer
  const byReviewer = new Map<string, GitHubReview>();
  for (const r of reviews) {
    if (r.state === "COMMENTED") continue;
    byReviewer.set(r.user.login, r);
  }
  const states = Array.from(byReviewer.values()).map((r) => r.state);
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (states.includes("APPROVED")) return "approved";
  return "none";
}

function countNewComments(
  prAuthor: string,
  lastCommitDate: string | null,
  comments: GitHubComment[],
  reviewComments: GitHubComment[],
  reviews: GitHubReview[],
): number {
  if (!lastCommitDate) return 0;
  const cutoff = new Date(lastCommitDate).getTime();
  let count = 0;

  for (const c of comments) {
    if (!isBotUser(c.user.login) && new Date(c.created_at).getTime() > cutoff) {
      count++;
    }
  }
  for (const c of reviewComments) {
    if (!isBotUser(c.user.login) && new Date(c.created_at).getTime() > cutoff) {
      count++;
    }
  }
  for (const r of reviews) {
    if (
      !isBotUser(r.user.login) &&
      r.body &&
      new Date(r.submitted_at).getTime() > cutoff
    ) {
      count++;
    }
  }

  return count;
}

export function PullRequestList() {
  // Poll task states every 2s for real-time progress timestamps
  const [liveTasksByBranch, setLiveTasksByBranch] = useState<
    Map<string, TaskState>
  >(new Map());
  const [liveTasksByKey, setLiveTasksByKey] = useState<Map<string, TaskState>>(
    new Map(),
  );
  const [loadingPhase, setLoadingPhase] = useState("Fetching pull requests...");

  useEffect(() => {
    async function pollTasks() {
      const tasks = await getAllTasks();
      const byBranch = new Map<string, TaskState>();
      const byKey = new Map<string, TaskState>();
      for (const t of tasks) {
        byBranch.set(t.branchName, t);
        byKey.set(t.issueKey, t);
      }
      setLiveTasksByBranch(byBranch);
      setLiveTasksByKey(byKey);
    }
    pollTasks();
    const interval = setInterval(pollTasks, 2000);
    return () => clearInterval(interval);
  }, []);

  const { data, isLoading, error, revalidate } = usePromise(async () => {
    const fs = await import("fs/promises");
    const { execSync } = await import("child_process");

    setLoadingPhase("Fetching pull requests...");
    const [prs, tasks] = await Promise.all([fetchMyOpenPRs(), getAllTasks()]);

    const tasksByBranch = new Map<string, TaskState>();
    for (const t of tasks) {
      tasksByBranch.set(t.branchName, t);
    }

    // Detect current QA repo branch and fetch latest refs
    const config = getConfig();
    let qaCurrentBranch: string | null = null;
    const qaUnpulledCounts = new Map<string, number>();
    if (config.extensionQaRepoPath) {
      setLoadingPhase("Syncing QA repository...");
      try {
        qaCurrentBranch = execSync("git branch --show-current", {
          cwd: config.extensionQaRepoPath,
          stdio: "pipe",
        })
          .toString()
          .trim();

        // Fetch latest refs so we can compare
        execSync("git fetch origin", {
          cwd: config.extensionQaRepoPath,
          stdio: "pipe",
        });

        // Count unpulled commits for the current branch
        if (qaCurrentBranch) {
          try {
            const count = parseInt(
              execSync(`git rev-list HEAD..origin/${qaCurrentBranch} --count`, {
                cwd: config.extensionQaRepoPath,
                stdio: "pipe",
              })
                .toString()
                .trim(),
              10,
            );
            if (count > 0) {
              qaUnpulledCounts.set(qaCurrentBranch, count);
            }
          } catch {
            // Remote branch may not exist yet
          }
        }
      } catch {
        // QA repo not available
      }
    }

    // Enrich PRs with review and check status
    setLoadingPhase(
      `Loading details for ${prs.length} pull request${prs.length === 1 ? "" : "s"}...`,
    );
    const enriched: EnrichedPR[] = await Promise.all(
      prs.map(async (pr) => {
        const taskState = tasksByBranch.get(pr.head.ref);
        let reviewState: EnrichedPR["reviewState"] = "none";
        const checksStatus: EnrichedPR["checksStatus"] = "none";

        let newCommentCount = 0;
        let lastCommitDate: string | null = null;
        let planExists = false;
        let previewUrl: string | null = null;

        // Check if plan file exists
        const planPath = getPlanFilePath(pr.head.ref);
        try {
          await fs.access(planPath);
          planExists = true;
        } catch {
          // Plan doesn't exist
        }

        try {
          const { owner, repo } = parseFullName(pr.base.repo.full_name);
          const [reviews, comments, reviewComments, commits] =
            await Promise.all([
              fetchReviews(owner, repo, pr.number),
              // fetchCheckRuns(owner, repo, pr.head.sha),
              fetchPRComments(owner, repo, pr.number),
              fetchReviewComments(owner, repo, pr.number),
              fetchPRCommits(owner, repo, pr.number),
            ]);
          reviewState = deriveReviewState(reviews);
          // if (checks.total_count === 0) {
          //   checksStatus = "none";
          // } else if (checks.check_runs.every(c => c.conclusion === "success")) {
          //   checksStatus = "success";
          // } else if (checks.check_runs.some(c => c.conclusion === "failure")) {
          //   checksStatus = "failure";
          // } else {
          //   checksStatus = "pending";
          // }
          lastCommitDate = getLastCommitDate(commits);
          newCommentCount = countNewComments(
            pr.user.login,
            lastCommitDate,
            comments,
            reviewComments,
            reviews,
          );

          // Detect preview URL from issue comments for pulse-frontend PRs
          if (pr.base.repo.name === REPOS.frontend) {
            const deployedPattern = /deployed to (https?:\/\/\S+)/i;
            for (const c of comments) {
              const match = c.body.match(deployedPattern);
              if (match) {
                previewUrl = match[1];
              }
            }
          }
        } catch {
          // Keep defaults
        }

        const isExtension = pr.base.repo.name === REPOS.extension;
        const qaCheckedOut = isExtension && qaCurrentBranch === pr.head.ref;
        const qaUnpulledCount = qaCheckedOut
          ? (qaUnpulledCounts.get(pr.head.ref) ?? 0)
          : 0;

        return {
          pr,
          taskState,
          reviewState,
          checksStatus,
          newCommentCount,
          lastCommitDate,
          planExists,
          previewUrl,
          qaCheckedOut,
          qaUnpulledCount,
        };
      }),
    );

    // Also find tasks that are in-progress (no PR yet)
    const inProgressTasksRaw = tasks.filter(
      (t) =>
        !["complete", "pr_created", "error", "cancelled"].includes(t.status) &&
        !prs.some((pr) => pr.head.ref === t.branchName),
    );

    // Check plan existence for in-progress tasks
    const inProgressTasks = await Promise.all(
      inProgressTasksRaw.map(async (task) => {
        const planPath = getPlanFilePath(task.branchName);
        let planExists = false;
        try {
          await fs.access(planPath);
          planExists = true;
        } catch {
          // Plan doesn't exist
        }
        return { task, planExists, planPath };
      }),
    );

    return { enriched, inProgressTasks };
  });

  if (error) {
    showToast({
      style: Toast.Style.Failure,
      title: "Failed to fetch PRs",
      message: error.message,
    });
  }

  // Separate draft PRs first - they go in their own section at the end
  const draftPRs = data?.enriched.filter((e) => e.pr.draft) ?? [];
  const nonDraftPRs = data?.enriched.filter((e) => !e.pr.draft) ?? [];

  const inProgressPRs = nonDraftPRs.filter(
    (e) =>
      e.taskState &&
      !["complete", "error", "cancelled"].includes(e.taskState.status),
  );
  const needsAttention = nonDraftPRs.filter(
    (e) =>
      !inProgressPRs.includes(e) &&
      (e.reviewState === "changes_requested" ||
        e.checksStatus === "failure" ||
        e.newCommentCount > 0),
  );
  const awaitingReview = nonDraftPRs.filter(
    (e) => !inProgressPRs.includes(e) && !needsAttention.includes(e),
  );

  // Active tasks shown immediately from live poll before the full data loads.
  // Once data is available, data.inProgressTasks takes over (it has plan info).
  const liveActiveTasks =
    isLoading && !data
      ? Array.from(liveTasksByKey.values()).filter(
          (t) =>
            !["complete", "pr_created", "error", "cancelled"].includes(
              t.status,
            ),
        )
      : [];

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter pull requests...">
      {/* Show active tasks right away from live poll while GitHub data loads */}
      {liveActiveTasks.length > 0 && (
        <List.Section title="Claude In Progress (No PR Yet)">
          {liveActiveTasks.map((task) => {
            const liveTimestamp = getLatestLogTimestamp(task.progressLog);
            return (
              <List.Item
                key={task.issueKey}
                title={`${task.issueKey}: ${task.issueSummary}`}
                subtitle={task.repoName}
                icon={{ source: Icon.Clock, tintColor: Color.Yellow }}
                accessories={[
                  ...(liveTimestamp
                    ? [
                        {
                          tag: {
                            value: liveTimestamp,
                            color: Color.SecondaryText,
                          },
                        },
                      ]
                    : []),
                  {
                    tag: {
                      value: TASK_STATUS_LABELS[task.status] || task.status,
                      color: Color.Yellow,
                    },
                  },
                ]}
                actions={
                  <ActionPanel>
                    <Action.Push
                      title="View Progress"
                      icon={Icon.Eye}
                      target={<ExecutionProgress issueKey={task.issueKey} />}
                    />
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      )}

      {/* Loading status shown when there's nothing to display yet */}
      {isLoading && !data && liveActiveTasks.length === 0 && (
        <List.EmptyView title={loadingPhase} icon={Icon.Clock} />
      )}

      {(data?.inProgressTasks?.length ?? 0) > 0 && (
        <List.Section title="Claude In Progress (No PR Yet)">
          {data!.inProgressTasks.map(({ task, planExists, planPath }) => {
            const liveTask = liveTasksByKey.get(task.issueKey);
            const liveTimestamp = liveTask
              ? getLatestLogTimestamp(liveTask.progressLog)
              : null;
            return (
              <List.Item
                key={task.issueKey}
                title={`${task.issueKey}: ${task.issueSummary}`}
                subtitle={task.repoName}
                icon={{ source: Icon.Clock, tintColor: Color.Yellow }}
                accessories={[
                  ...(liveTimestamp
                    ? [
                        {
                          tag: {
                            value: liveTimestamp,
                            color: Color.SecondaryText,
                          },
                        },
                      ]
                    : []),
                  ...(planExists
                    ? [
                        {
                          icon: {
                            source: Icon.Document,
                            tintColor: Color.Blue,
                          },
                          tooltip: "Plan available",
                        },
                      ]
                    : []),
                  {
                    tag: {
                      value: TASK_STATUS_LABELS[task.status] || task.status,
                      color: Color.Yellow,
                    },
                  },
                ]}
                actions={
                  <ActionPanel>
                    <Action.Push
                      title="View Progress"
                      icon={Icon.Eye}
                      target={<ExecutionProgress issueKey={task.issueKey} />}
                    />
                    {planExists && (
                      <>
                        <Action.Push
                          title="Update Plan"
                          icon={Icon.Pencil}
                          target={<PlanFeedbackForm task={task} />}
                        />
                        <Action.Open
                          title="Open Plan in VS Code"
                          icon={Icon.Code}
                          target={planPath}
                          application="Code"
                        />
                      </>
                    )}
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      )}

      {needsAttention.length > 0 && (
        <List.Section title="Needs Attention">
          {needsAttention.map((e) => (
            <PRListItem
              key={e.pr.id}
              enriched={e}
              revalidate={revalidate}
              liveTask={liveTasksByBranch.get(e.pr.head.ref)}
            />
          ))}
        </List.Section>
      )}

      {inProgressPRs.length > 0 && (
        <List.Section title="In Progress">
          {inProgressPRs.map((e) => (
            <PRListItem
              key={e.pr.id}
              enriched={e}
              revalidate={revalidate}
              liveTask={liveTasksByBranch.get(e.pr.head.ref)}
            />
          ))}
        </List.Section>
      )}

      {awaitingReview.length > 0 && (
        <List.Section title="Awaiting Review">
          {awaitingReview.map((e) => (
            <PRListItem
              key={e.pr.id}
              enriched={e}
              revalidate={revalidate}
              liveTask={liveTasksByBranch.get(e.pr.head.ref)}
            />
          ))}
        </List.Section>
      )}

      {draftPRs.length > 0 && (
        <List.Section title="Draft">
          {draftPRs.map((e) => (
            <PRListItem
              key={e.pr.id}
              enriched={e}
              revalidate={revalidate}
              liveTask={liveTasksByBranch.get(e.pr.head.ref)}
            />
          ))}
        </List.Section>
      )}

      {!isLoading &&
        !data?.enriched?.length &&
        !data?.inProgressTasks?.length && (
          <List.EmptyView
            title="No open pull requests"
            description="Launch 'Implement Task' to create your first PR."
            icon={Icon.Checkmark}
          />
        )}
    </List>
  );
}

function PRListItem({
  enriched,
  revalidate,
  liveTask,
}: {
  enriched: EnrichedPR;
  revalidate: () => void;
  liveTask?: TaskState;
}) {
  const {
    pr,
    taskState,
    reviewState,
    checksStatus,
    newCommentCount,
    lastCommitDate,
    planExists,
    previewUrl,
  } = enriched;
  const repoName = pr.base.repo.name;
  const isTaskActive = taskState && ACTIVE_STATUSES.has(taskState.status);
  const liveTimestamp =
    liveTask && ACTIVE_STATUSES.has(liveTask.status)
      ? getLatestLogTimestamp(liveTask.progressLog)
      : null;

  const accessories: List.Item.Accessory[] = [];
  if (planExists) {
    accessories.push({
      icon: { source: Icon.Document, tintColor: Color.Blue },
      tooltip: "Plan available",
    });
  }
  if (taskState) {
    accessories.push({
      icon: taskStatusIcon(taskState.status),
      tooltip: TASK_STATUS_LABELS[taskState.status],
    });
  }
  if (liveTimestamp) {
    accessories.push({
      tag: { value: liveTimestamp, color: Color.SecondaryText },
      tooltip: "Last activity",
    });
  }
  const rIcon = reviewIcon(reviewState);
  if (rIcon) {
    accessories.push({ icon: rIcon, tooltip: reviewTooltip(reviewState) });
  }
  const cIcon = checksIcon(checksStatus);
  if (cIcon) {
    accessories.push({ icon: cIcon, tooltip: checksTooltip(checksStatus) });
  }
  if (newCommentCount > 0) {
    accessories.push({
      icon: { source: Icon.SpeechBubble, tintColor: Color.Blue },
      text: { value: String(newCommentCount), color: Color.Blue },
      tooltip:
        newCommentCount === 1
          ? "1 new comment"
          : `${newCommentCount} new comments`,
    });
  }
  if (previewUrl) {
    accessories.push({
      icon: { source: Icon.Globe, tintColor: Color.Purple },
      tooltip: "Preview available",
    });
  }
  const isExtensionRepo = repoName === REPOS.extension;
  if (isExtensionRepo) {
    if (enriched.qaCheckedOut) {
      accessories.push({
        icon: { source: Icon.Window, tintColor: Color.Green },
        ...(enriched.qaUnpulledCount > 0
          ? {
              text: {
                value: String(enriched.qaUnpulledCount),
                color: Color.Orange,
              },
              tooltip: `Checked out — ${enriched.qaUnpulledCount} unpulled commit${enriched.qaUnpulledCount === 1 ? "" : "s"}`,
            }
          : { tooltip: "Checked out in QA repo" }),
      });
    } else {
      accessories.push({
        icon: { source: Icon.Window, tintColor: Color.Orange },
        tooltip: "QA checkout available",
      });
    }
  }
  if (pr.labels && pr.labels.length > 0) {
    for (const label of pr.labels) {
      accessories.push({
        tag: { value: label.name, color: hexToRaycastColor(label.color) },
      });
    }
  }
  accessories.push({ text: repoName });

  return (
    <List.Item
      title={pr.title}
      subtitle={`#${pr.number}`}
      icon={
        pr.draft
          ? { source: Icon.Document, tintColor: Color.SecondaryText }
          : { source: Icon.CodeBlock, tintColor: Color.Purple }
      }
      accessories={accessories}
      actions={
        <ActionPanel>
          {isTaskActive ? (
            <>
              <Action.Push
                title="View Progress"
                icon={Icon.CircleProgress}
                target={<ExecutionProgress issueKey={taskState.issueKey} />}
              />
              <Action.Push
                title="View Details"
                icon={Icon.Eye}
                target={
                  <PullRequestDetail
                    pr={pr}
                    taskState={taskState}
                    lastCommitDate={lastCommitDate}
                  />
                }
                shortcut={{ modifiers: ["cmd"], key: "d" }}
              />
            </>
          ) : (
            <>
              <Action.Push
                title="View Details"
                icon={Icon.Eye}
                target={
                  <PullRequestDetail
                    pr={pr}
                    taskState={taskState}
                    lastCommitDate={lastCommitDate}
                  />
                }
              />
              {taskState && (
                <Action.Push
                  title="View Progress"
                  icon={Icon.CircleProgress}
                  target={<ExecutionProgress issueKey={taskState.issueKey} />}
                />
              )}
            </>
          )}
          {previewUrl && (
            <Action.Open
              title="Open Dev Build"
              icon={Icon.Globe}
              target={previewUrl}
              application="Helium"
            />
          )}
          {isExtensionRepo &&
            enriched.qaCheckedOut &&
            enriched.qaUnpulledCount > 0 && (
              <Action
                title="Pull Updates"
                icon={{ source: Icon.Download, tintColor: Color.Green }}
                onAction={async () => {
                  const { extensionQaRepoPath } = getConfig();
                  try {
                    const { execSync } = await import("child_process");
                    execSync("git pull", {
                      cwd: extensionQaRepoPath,
                      stdio: "pipe",
                    });
                    showToast({
                      style: Toast.Style.Success,
                      title: `Pulled ${enriched.qaUnpulledCount} commit${enriched.qaUnpulledCount === 1 ? "" : "s"}`,
                      message: pr.head.ref,
                    });
                    revalidate();
                  } catch (e: unknown) {
                    showToast({
                      style: Toast.Style.Failure,
                      title: "Pull failed",
                      message: e instanceof Error ? e.message : String(e),
                    });
                  }
                }}
              />
            )}
          {isExtensionRepo && !enriched.qaCheckedOut && (
            <Action
              title="Checkout QA Branch"
              icon={{ source: Icon.Window, tintColor: Color.Orange }}
              onAction={async () => {
                const { extensionQaRepoPath } = getConfig();
                if (!extensionQaRepoPath) {
                  showToast({
                    style: Toast.Style.Failure,
                    title: "EXTENSION_QA_REPO_PATH not configured",
                  });
                  return;
                }
                try {
                  const { execSync } = await import("child_process");
                  const branch = pr.head.ref;
                  execSync(
                    `git fetch origin && git checkout ${branch} && git pull`,
                    {
                      cwd: extensionQaRepoPath,
                      stdio: "pipe",
                    },
                  );
                  showToast({
                    style: Toast.Style.Success,
                    title: `Checked out ${branch}`,
                    message: "QA repo switched and pulled",
                  });
                  revalidate();
                } catch (e: unknown) {
                  showToast({
                    style: Toast.Style.Failure,
                    title: "Checkout failed",
                    message: e instanceof Error ? e.message : String(e),
                  });
                }
              }}
            />
          )}
          <Action.OpenInBrowser
            title="Open on GitHub"
            url={pr.html_url}
            icon={{ source: "github.svg" }}
          />
        </ActionPanel>
      }
    />
  );
}

function parseFullName(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  return { owner, repo };
}

/** Extract the time part from the last progressLog entry, e.g. "14:23:45". */
function getLatestLogTimestamp(progressLog: string[]): string | null {
  if (progressLog.length === 0) return null;
  const last = progressLog[progressLog.length - 1];
  const match = last.match(/^\[([^\]]+)\]/);
  return match ? match[1] : null;
}
