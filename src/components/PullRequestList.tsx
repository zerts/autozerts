import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import {
  fetchMyOpenPRs,
  fetchCheckRuns,
  fetchReviews,
} from "../services/github";
import { getAllTasks } from "../utils/storage";
import type { GitHubPullRequest, GitHubReview } from "../types/github";
import type { TaskState } from "../types/storage";
import { PullRequestDetail } from "./PullRequestDetail";
import { ExecutionProgress } from "./ExecutionProgress";

interface EnrichedPR {
  pr: GitHubPullRequest;
  taskState?: TaskState;
  reviewState: "approved" | "changes_requested" | "pending" | "none";
  checksStatus: "success" | "failure" | "pending" | "none";
}

function reviewStateColor(state: EnrichedPR["reviewState"]): Color {
  switch (state) {
    case "approved":
      return Color.Green;
    case "changes_requested":
      return Color.Red;
    case "pending":
      return Color.Yellow;
    default:
      return Color.SecondaryText;
  }
}

function checksStatusColor(status: EnrichedPR["checksStatus"]): Color {
  switch (status) {
    case "success":
      return Color.Green;
    case "failure":
      return Color.Red;
    case "pending":
      return Color.Yellow;
    default:
      return Color.SecondaryText;
  }
}

function reviewLabel(state: EnrichedPR["reviewState"]): string {
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
  return "pending";
}

export function PullRequestList() {
  const { data, isLoading, error } = usePromise(async () => {
    const [prs, tasks] = await Promise.all([fetchMyOpenPRs(), getAllTasks()]);

    const tasksByBranch = new Map<string, TaskState>();
    for (const t of tasks) {
      tasksByBranch.set(t.branchName, t);
    }

    // Enrich PRs with review and check status
    const enriched: EnrichedPR[] = await Promise.all(
      prs.map(async (pr) => {
        const taskState = tasksByBranch.get(pr.head.ref);
        let reviewState: EnrichedPR["reviewState"] = "none";
        let checksStatus: EnrichedPR["checksStatus"] = "none";

        try {
          const { owner, repo } = parseFullName(pr.base.repo.full_name);
          const [reviews, checks] = await Promise.all([
            fetchReviews(owner, repo, pr.number),
            fetchCheckRuns(owner, repo, pr.head.sha),
          ]);
          reviewState = deriveReviewState(reviews);
          if (checks.total_count === 0) {
            checksStatus = "none";
          } else if (
            checks.check_runs.every((c) => c.conclusion === "success")
          ) {
            checksStatus = "success";
          } else if (
            checks.check_runs.some((c) => c.conclusion === "failure")
          ) {
            checksStatus = "failure";
          } else {
            checksStatus = "pending";
          }
        } catch {
          // Keep defaults
        }

        return { pr, taskState, reviewState, checksStatus };
      }),
    );

    // Also find tasks that are in-progress (no PR yet)
    const inProgressTasks = tasks.filter(
      (t) =>
        !["complete", "pr_created", "error", "cancelled"].includes(t.status) &&
        !prs.some((pr) => pr.head.ref === t.branchName),
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

  const inProgressPRs =
    data?.enriched.filter(
      (e) =>
        e.taskState &&
        !["complete", "error", "cancelled"].includes(e.taskState.status),
    ) ?? [];
  const needsAttention =
    data?.enriched.filter(
      (e) =>
        e.reviewState === "changes_requested" || e.checksStatus === "failure",
    ) ?? [];
  const awaitingReview =
    data?.enriched.filter(
      (e) => !inProgressPRs.includes(e) && !needsAttention.includes(e),
    ) ?? [];

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter pull requests...">
      {(data?.inProgressTasks?.length ?? 0) > 0 && (
        <List.Section title="Claude In Progress (No PR Yet)">
          {data!.inProgressTasks.map((task) => (
            <List.Item
              key={task.jiraKey}
              title={`${task.jiraKey}: ${task.jiraSummary}`}
              subtitle={task.repoName}
              icon={{ source: Icon.Clock, tintColor: Color.Yellow }}
              accessories={[
                { tag: { value: task.status, color: Color.Yellow } },
              ]}
              actions={
                <ActionPanel>
                  <Action.Push
                    title="View Progress"
                    icon={Icon.Eye}
                    target={<ExecutionProgress jiraKey={task.jiraKey} />}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {needsAttention.length > 0 && (
        <List.Section title="Needs Attention">
          {needsAttention.map((e) => (
            <PRListItem key={e.pr.id} enriched={e} />
          ))}
        </List.Section>
      )}

      {inProgressPRs.length > 0 && (
        <List.Section title="In Progress">
          {inProgressPRs.map((e) => (
            <PRListItem key={e.pr.id} enriched={e} />
          ))}
        </List.Section>
      )}

      {awaitingReview.length > 0 && (
        <List.Section title="Awaiting Review">
          {awaitingReview.map((e) => (
            <PRListItem key={e.pr.id} enriched={e} />
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

function PRListItem({ enriched }: { enriched: EnrichedPR }) {
  const { pr, taskState, reviewState, checksStatus } = enriched;
  const repoName = pr.base.repo.name;

  const isTaskActive =
    taskState != null &&
    !["complete", "error", "cancelled"].includes(taskState.status);

  const accessories: List.Item.Accessory[] = [];
  if (isTaskActive) {
    accessories.push({
      tag: { value: "Claude Running", color: Color.Orange },
    });
  }
  if (reviewState !== "none") {
    accessories.push({
      tag: {
        value: reviewLabel(reviewState),
        color: reviewStateColor(reviewState),
      },
    });
  }
  if (checksStatus !== "none") {
    accessories.push({
      tag: {
        value:
          checksStatus === "success"
            ? "Checks Pass"
            : checksStatus === "failure"
              ? "Checks Fail"
              : "Checks Running",
        color: checksStatusColor(checksStatus),
      },
    });
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
            <Action.Push
              title="View Progress"
              icon={Icon.Clock}
              target={<ExecutionProgress jiraKey={taskState.jiraKey} />}
            />
          ) : (
            <Action.Push
              title="View Details"
              icon={Icon.Eye}
              target={
                <PullRequestDetail pr={pr} taskState={taskState} />
              }
            />
          )}
          <Action.OpenInBrowser title="Open on GitHub" url={pr.html_url} />
        </ActionPanel>
      }
    />
  );
}

function parseFullName(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  return { owner, repo };
}
