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
  parseRepoFullName,
} from "../services/github";
import { FeedbackForm } from "./FeedbackForm";

interface PullRequestDetailProps {
  pr: GitHubPullRequest;
  taskState?: TaskState;
}

export function PullRequestDetail({ pr, taskState }: PullRequestDetailProps) {
  const { owner, repo } = parseRepoFullName(pr.base.repo.full_name);

  const { data, isLoading } = usePromise(async () => {
    const [reviews, comments, reviewComments] = await Promise.all([
      fetchReviews(owner, repo, pr.number),
      fetchPRComments(owner, repo, pr.number),
      fetchReviewComments(owner, repo, pr.number),
    ]);
    return { reviews, comments, reviewComments };
  });

  const markdown = buildPRDetailMarkdown(
    pr,
    data?.reviews,
    data?.comments,
    data?.reviewComments,
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
          {taskState?.jiraUrl && (
            <Detail.Metadata.Link
              title="JIRA"
              target={taskState.jiraUrl}
              text={taskState.jiraKey}
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
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action.Push
            title="Add Feedback"
            icon={Icon.Message}
            target={<FeedbackForm pr={pr} taskState={taskState} />}
          />
          <Action.OpenInBrowser title="Open on GitHub" url={pr.html_url} />
          {taskState?.jiraUrl && (
            <Action.OpenInBrowser
              title="Open in Jira"
              url={taskState.jiraUrl}
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

function buildPRDetailMarkdown(
  pr: GitHubPullRequest,
  reviews?: GitHubReview[],
  comments?: GitHubComment[],
  reviewComments?: GitHubComment[],
): string {
  const sections: string[] = [];

  sections.push(`# ${pr.title}`);
  sections.push("");

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
      sections.push(`${stateEmoji} **${review.user.login}** — ${review.state}`);
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
      sections.push(`**${comment.user.login}** ${location}`);
      sections.push(comment.body);
      sections.push("");
    }
  }

  // PR comments
  if (comments && comments.length > 0) {
    sections.push("## Comments");
    sections.push("");
    for (const comment of comments) {
      sections.push(
        `**${comment.user.login}** (${new Date(comment.created_at).toLocaleDateString()}):`,
      );
      sections.push(comment.body);
      sections.push("");
    }
  }

  return sections.join("\n");
}
