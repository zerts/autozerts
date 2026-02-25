import {
  Form,
  ActionPanel,
  Action,
  Icon,
  showToast,
  Toast,
  useNavigation,
  launchCommand,
  LaunchType,
} from "@raycast/api";
import { useState } from "react";
import { usePromise } from "@raycast/utils";
import type {
  GitHubPullRequest,
  GitHubReview,
  GitHubComment,
} from "../types/github";
import type { TaskState } from "../types/storage";
import { getConfig } from "../utils/preferences";
import {
  getTask,
  saveOrchestrationParams,
  updateTaskStatus,
  appendProgressLog,
} from "../utils/storage";
import {
  parseRepoFullName,
  fetchReviews,
  fetchPRComments,
  fetchReviewComments,
  fetchPRCommits,
  getLastCommitDate,
  isBotUser,
} from "../services/github";
import { ExecutionProgress } from "./ExecutionProgress";

interface FeedbackFormProps {
  pr: GitHubPullRequest;
  taskState?: TaskState;
  lastCommitDate?: string | null;
}

interface NewCommentItem {
  type: "review" | "inline" | "comment";
  user: string;
  body: string;
  location?: string;
  state?: string;
}

function collectNewComments(
  lastCommitDate: string | null,
  comments: GitHubComment[],
  reviewComments: GitHubComment[],
  reviews: GitHubReview[],
): NewCommentItem[] {
  if (!lastCommitDate) return [];
  const cutoff = new Date(lastCommitDate).getTime();
  const items: NewCommentItem[] = [];

  for (const r of reviews) {
    if (
      !isBotUser(r.user.login) &&
      r.body &&
      new Date(r.submitted_at).getTime() > cutoff
    ) {
      items.push({
        type: "review",
        user: r.user.login,
        body: r.body,
        state: r.state,
      });
    }
  }
  for (const c of reviewComments) {
    if (!isBotUser(c.user.login) && new Date(c.created_at).getTime() > cutoff) {
      const location = c.path
        ? `${c.path}${c.line ? `:${c.line}` : ""}`
        : undefined;
      items.push({
        type: "inline",
        user: c.user.login,
        body: c.body,
        location,
      });
    }
  }
  for (const c of comments) {
    if (!isBotUser(c.user.login) && new Date(c.created_at).getTime() > cutoff) {
      items.push({ type: "comment", user: c.user.login, body: c.body });
    }
  }

  return items;
}

function buildNewCommentsContext(items: NewCommentItem[]): string | undefined {
  if (items.length === 0) return undefined;
  const lines = items.map((item) => {
    if (item.type === "review") {
      return `[Review by ${item.user} — ${item.state}]: ${item.body}`;
    } else if (item.type === "inline") {
      const loc = item.location ? ` (${item.location})` : "";
      return `[Inline comment by ${item.user}${loc}]: ${item.body}`;
    } else {
      return `[Comment by ${item.user}]: ${item.body}`;
    }
  });
  return lines.join("\n\n");
}

export function FeedbackForm({
  pr,
  taskState,
  lastCommitDate: passedLastCommitDate,
}: FeedbackFormProps) {
  const config = getConfig();
  const { push } = useNavigation();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { owner: prOwner, repo: prRepo } = parseRepoFullName(
    pr.base.repo.full_name,
  );

  const { data: newCommentsData } = usePromise(async () => {
    const [reviews, comments, reviewComments, commits] = await Promise.all([
      fetchReviews(prOwner, prRepo, pr.number),
      fetchPRComments(prOwner, prRepo, pr.number),
      fetchReviewComments(prOwner, prRepo, pr.number),
      fetchPRCommits(prOwner, prRepo, pr.number),
    ]);
    const resolvedDate =
      getLastCommitDate(commits) ?? passedLastCommitDate ?? null;
    const items = collectNewComments(
      resolvedDate,
      comments,
      reviewComments,
      reviews,
    );
    const context = buildNewCommentsContext(items);
    return { items, context, count: items.length };
  });

  const newCommentCount = newCommentsData?.count ?? 0;
  const hasNewComments = newCommentCount > 0;

  async function handleSubmit(values: {
    feedbackText: string;
    includeNewComments: boolean;
    autoImplement: boolean;
    postAsComment: boolean;
  }) {
    const hasText = values.feedbackText.trim().length > 0;
    const willIncludeComments = values.includeNewComments && hasNewComments;
    if (!hasText && !willIncludeComments) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Provide feedback text or include new comments",
      });
      return;
    }

    setIsSubmitting(true);

    try {
      const { repo: repoName } = parseRepoFullName(pr.base.repo.full_name);
      const repo = config.repos.find((r) => r.name === repoName);
      if (!repo) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Repository not found in config",
          message: repoName,
        });
        setIsSubmitting(false);
        return;
      }

      // Find or create task state
      let task = taskState;
      if (!task) {
        // Try to find by branch name
        task = (await getTask(pr.head.ref)) ?? undefined;
      }

      if (!task) {
        // Create a minimal task state for tracking
        const { createInitialTaskState, saveTask } =
          await import("../utils/storage");
        const issueKeyMatch = pr.title.match(/^([A-Z]+-\d+)/);
        const issueKey = issueKeyMatch?.[1] ?? `PR-${pr.number}`;
        task = createInitialTaskState({
          issueKey,
          issueSummary: pr.title,
          issueUrl: pr.html_url,
          repoName: repo.name,
          branchName: pr.head.ref,
          worktreePath: `${config.worktreeBasePath}/${repo.name}/${pr.head.ref}`,
          baseBranch: pr.base.ref,
        });
        task.prUrl = pr.html_url;
        task.prNumber = pr.number;
        await saveTask(task);
      }

      if (values.autoImplement) {
        // Mark the task as actively processing feedback so the UI reflects it
        await updateTaskStatus(task.issueKey, "feedback_implementing");
        await appendProgressLog(
          task.issueKey,
          "Feedback submitted — starting implementation...",
        );

        // Navigate to progress view
        push(<ExecutionProgress issueKey={task.issueKey} />);

        // Save params and launch background orchestration command
        await saveOrchestrationParams(task.issueKey, {
          mode: "feedback",
          issueKey: task.issueKey,
          repoName: repo.name,
          feedbackText: values.feedbackText,
          postAsComment: values.postAsComment,
          newCommentsContext: willIncludeComments
            ? newCommentsData?.context
            : undefined,
        });
        await launchCommand({
          name: "run-orchestration",
          type: LaunchType.UserInitiated,
          context: { issueKey: task.issueKey },
        });

        await showToast({
          style: Toast.Style.Animated,
          title: "Feedback implementation started",
        });
      } else {
        // Just post the comment without auto-implementing
        if (values.postAsComment && values.feedbackText.trim().length > 0) {
          const { addPRComment } = await import("../services/github");
          await addPRComment(
            config.githubOwner,
            repo.name,
            pr.number,
            values.feedbackText,
          );
          await showToast({
            style: Toast.Style.Success,
            title: "Comment posted",
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await showToast({ style: Toast.Style.Failure, title: "Failed", message });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Form
      isLoading={isSubmitting}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Submit Feedback"
            icon={Icon.Message}
            onSubmit={handleSubmit}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Pull Request"
        text={`#${pr.number}: ${pr.title}`}
      />

      <Form.TextArea
        id="feedbackText"
        title="Feedback"
        placeholder="Describe what changes are needed..."
      />

      {hasNewComments && (
        <>
          <Form.Separator />
          <Form.Description
            title="New Comments"
            text={`${newCommentCount} comment${newCommentCount === 1 ? "" : "s"} since last commit`}
          />
          {newCommentsData?.items.map((item, idx) => {
            let title = "";
            if (item.type === "review") {
              title = `${item.user} (${item.state})`;
            } else if (item.type === "inline") {
              title = item.location
                ? `${item.user} on ${item.location}`
                : item.user;
            } else {
              title = item.user;
            }
            return (
              <Form.Description
                key={idx}
                title={title}
                text={
                  item.body.length > 200
                    ? `${item.body.slice(0, 200)}...`
                    : item.body
                }
              />
            );
          })}
          <Form.Checkbox
            id="includeNewComments"
            label="Include these comments as context"
            defaultValue={true}
          />
        </>
      )}

      <Form.Separator />

      <Form.Checkbox
        id="autoImplement"
        label="Auto-implement with Claude Code"
        defaultValue={true}
      />
      <Form.Checkbox
        id="postAsComment"
        label="Post as GitHub comment"
        defaultValue={true}
      />
    </Form>
  );
}
