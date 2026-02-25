import { Detail, ActionPanel, Action, Icon, Color } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import type {
  GitHubPullRequest,
  GitHubReview,
  GitHubComment,
} from "../types/github";
import type { TaskState } from "../types/storage";
import {
  fetchReviews,
  fetchPRComments,
  fetchReviewComments,
  fetchPRCommits,
  getLastCommitDate,
  parseRepoFullName,
  isBotUser,
} from "../services/github";
import { getPlanFilePath } from "../services/worktree";
import { FeedbackForm } from "./FeedbackForm";

interface PullRequestDetailProps {
  pr: GitHubPullRequest;
  taskState?: TaskState;
  lastCommitDate?: string | null;
}

export function PullRequestDetail({
  pr,
  taskState,
  lastCommitDate: passedLastCommitDate,
}: PullRequestDetailProps) {
  const { owner, repo } = parseRepoFullName(pr.base.repo.full_name);

  const planFilePath = getPlanFilePath(pr.head.ref);

  const { data, isLoading } = usePromise(async () => {
    const fs = await import("fs/promises");
    const [reviews, comments, reviewComments, commits] = await Promise.all([
      fetchReviews(owner, repo, pr.number),
      fetchPRComments(owner, repo, pr.number),
      fetchReviewComments(owner, repo, pr.number),
      fetchPRCommits(owner, repo, pr.number),
    ]);
    const fetchedLastCommitDate = getLastCommitDate(commits);

    let planExists = false;
    try {
      await fs.access(planFilePath);
      planExists = true;
    } catch {
      // Plan file doesn't exist
    }

    return {
      reviews,
      comments,
      reviewComments,
      lastCommitDate: fetchedLastCommitDate,
      planExists,
    };
  });

  const resolvedLastCommitDate =
    data?.lastCommitDate ?? passedLastCommitDate ?? null;

  const markdown = buildPRDetailMarkdown(
    pr,
    data?.reviews,
    data?.comments,
    data?.reviewComments,
    resolvedLastCommitDate,
  );

  return (
    <Detail
      isLoading={isLoading}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="PR" text={`#${pr.number}`} />
          <Detail.Metadata.Label title="Repository" text={pr.base.repo.name} />
          <Detail.Metadata.Label
            title="Branch"
            text={`${pr.head.ref} → ${pr.base.ref}`}
          />
          <Detail.Metadata.Label
            title="Changes"
            text={`+${pr.additions} / -${pr.deletions} (${pr.changed_files} files)`}
          />
          <Detail.Metadata.TagList title="Status">
            <Detail.Metadata.TagList.Item
              text={
                pr.draft ? "Draft" : pr.state === "open" ? "Open" : "Closed"
              }
              color={
                pr.draft
                  ? Color.SecondaryText
                  : pr.state === "open"
                    ? Color.Green
                    : Color.Red
              }
            />
          </Detail.Metadata.TagList>
          {taskState?.issueUrl && (
            <Detail.Metadata.Link
              title="Linear"
              target={taskState.issueUrl}
              text={taskState.issueKey}
            />
          )}
          {taskState?.costUsd !== undefined && (
            <Detail.Metadata.Label
              title="Claude Cost"
              text={`$${taskState.costUsd.toFixed(2)}`}
            />
          )}
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label title="Author" text={pr.user.login} />
          <Detail.Metadata.Label
            title="Created"
            text={new Date(pr.created_at).toLocaleDateString()}
          />
          <Detail.Metadata.Label
            title="Updated"
            text={new Date(pr.updated_at).toLocaleDateString()}
          />
          {resolvedLastCommitDate && (
            <Detail.Metadata.Label
              title="Last Commit"
              text={new Date(resolvedLastCommitDate).toLocaleDateString()}
            />
          )}
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action.Push
            title="Add Feedback"
            icon={Icon.Message}
            target={
              <FeedbackForm
                pr={pr}
                taskState={taskState}
                lastCommitDate={resolvedLastCommitDate}
              />
            }
          />
          {data?.planExists && (
            <Action.Open
              title="Open Plan in VS Code"
              icon={Icon.Code}
              target={planFilePath}
              application="Code"
            />
          )}
          <Action.OpenInBrowser
            title="Open on GitHub"
            url={pr.html_url}
            icon={{ source: "github.svg" }}
          />
          {taskState?.issueUrl && (
            <Action.Open
              title="Open in Linear"
              icon={{ source: "linear.svg" }}
              target={taskState.issueUrl}
              application="Linear"
              shortcut={{ modifiers: ["cmd"], key: "j" }}
            />
          )}
          <Action.CopyToClipboard
            title="Copy Pr URL"
            content={pr.html_url}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
        </ActionPanel>
      }
    />
  );
}

function isNewComment(lastCommitDate: string | null, dateStr: string): boolean {
  if (!lastCommitDate) return false;
  return new Date(dateStr).getTime() > new Date(lastCommitDate).getTime();
}

function buildPRDetailMarkdown(
  pr: GitHubPullRequest,
  reviews?: GitHubReview[],
  comments?: GitHubComment[],
  reviewComments?: GitHubComment[],
  lastCommitDate?: string | null,
): string {
  const sections: string[] = [];

  sections.push(`# ${pr.title}`);
  sections.push("");

  // Count new comments for summary
  if (lastCommitDate) {
    let newCount = 0;
    if (reviews) {
      for (const r of reviews) {
        if (!isBotUser(r.user.login) && r.body && isNewComment(lastCommitDate, r.submitted_at)) {
          newCount++;
        }
      }
    }
    if (reviewComments) {
      for (const c of reviewComments) {
        if (!isBotUser(c.user.login) && isNewComment(lastCommitDate, c.created_at)) {
          newCount++;
        }
      }
    }
    if (comments) {
      for (const c of comments) {
        if (!isBotUser(c.user.login) && isNewComment(lastCommitDate, c.created_at)) {
          newCount++;
        }
      }
    }
    if (newCount > 0) {
      const dateStr = new Date(lastCommitDate).toLocaleDateString();
      sections.push(
        `> **${newCount} new comment${newCount === 1 ? "" : "s"} since last commit** (${dateStr})`,
      );
      sections.push("");
    }
  }

  if (pr.body) {
    sections.push(pr.body);
    sections.push("");
  }

  // Reviews
  if (reviews && reviews.length > 0) {
    sections.push("## Reviews");
    sections.push("");
    for (const review of reviews) {
      const stateEmoji =
        review.state === "APPROVED"
          ? "✅"
          : review.state === "CHANGES_REQUESTED"
            ? "❌"
            : "💬";
      const newBadge =
        !isBotUser(review.user.login) && review.body && isNewComment(lastCommitDate ?? null, review.submitted_at)
          ? " `NEW`"
          : "";
      sections.push(
        `${stateEmoji} **${review.user.login}** — ${review.state}${newBadge}`,
      );
      if (review.body) {
        sections.push(`> ${review.body}`);
      }
      sections.push("");
    }
  }

  // Review comments (inline)
  if (reviewComments && reviewComments.length > 0) {
    sections.push("## Inline Comments");
    sections.push("");
    for (const comment of reviewComments) {
      const location = comment.path
        ? `\`${comment.path}${comment.line ? `:${comment.line}` : ""}\``
        : "";
      const newBadge = !isBotUser(comment.user.login) && isNewComment(lastCommitDate ?? null, comment.created_at)
        ? " `NEW`"
        : "";
      sections.push(`**${comment.user.login}** ${location}${newBadge}`);
      sections.push(comment.body);
      sections.push("");
    }
  }

  // PR comments
  if (comments && comments.length > 0) {
    sections.push("## Comments");
    sections.push("");
    for (const comment of comments) {
      const newBadge = !isBotUser(comment.user.login) && isNewComment(lastCommitDate ?? null, comment.created_at)
        ? " `NEW`"
        : "";
      sections.push(
        `**${comment.user.login}** (${new Date(comment.created_at).toLocaleDateString()}):${newBadge}`,
      );
      sections.push(comment.body);
      sections.push("");
    }
  }

  return sections.join("\n");
}
