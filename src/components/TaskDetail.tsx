import { Detail, ActionPanel, Action, Icon, Color } from "@raycast/api";
import type { JiraIssue } from "../types/jira";
import { adfToMarkdown } from "../utils/adf-to-markdown";
import { issueUrl } from "../services/jira";
import { ContextForm } from "./ContextForm";

interface TaskDetailProps {
  issue: JiraIssue;
}

export function TaskDetail({ issue }: TaskDetailProps) {
  const descriptionMd = adfToMarkdown(issue.fields.description);
  const commentsMd = buildCommentsMd(issue);
  const markdown = buildMarkdown(issue, descriptionMd, commentsMd);

  return (
    <Detail
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Key" text={issue.key} />
          <Detail.Metadata.Label
            title="Type"
            text={issue.fields.issuetype.name}
          />
          <Detail.Metadata.Label
            title="Priority"
            text={issue.fields.priority.name}
          />
          <Detail.Metadata.TagList title="Status">
            <Detail.Metadata.TagList.Item
              text={issue.fields.status.name}
              color={
                issue.fields.status.statusCategory.key === "done"
                  ? Color.Green
                  : issue.fields.status.statusCategory.key === "indeterminate"
                    ? Color.Yellow
                    : Color.Blue
              }
            />
          </Detail.Metadata.TagList>
          {issue.fields.sprint && (
            <Detail.Metadata.Label
              title="Sprint"
              text={issue.fields.sprint.name}
            />
          )}
          <Detail.Metadata.Separator />
          {issue.fields.comment?.total !== undefined && (
            <Detail.Metadata.Label
              title="Comments"
              text={`${issue.fields.comment.total}`}
            />
          )}
          <Detail.Metadata.Link
            title="JIRA"
            target={issueUrl(issue.key)}
            text="Open in browser"
          />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action.Push
            title="Implement with Claude"
            icon={Icon.Hammer}
            target={
              <ContextForm issue={issue} descriptionMarkdown={descriptionMd} />
            }
          />
          <Action.OpenInBrowser
            title="Open in Jira"
            url={issueUrl(issue.key)}
            shortcut={{ modifiers: ["cmd"], key: "o" }}
          />
          <Action.CopyToClipboard
            title="Copy Description"
            content={descriptionMd}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
        </ActionPanel>
      }
    />
  );
}

function buildCommentsMd(issue: JiraIssue): string {
  const comments = issue.fields.comment?.comments;
  if (!comments || comments.length === 0) return "";

  const sections: string[] = [];
  sections.push("## Comments");
  sections.push("");
  for (const comment of comments) {
    const author = comment.author.displayName;
    const date = new Date(comment.created).toLocaleDateString();
    const body = adfToMarkdown(comment.body);
    sections.push(`**${author}** (${date}):`);
    sections.push(body);
    sections.push("");
  }
  return sections.join("\n");
}

function buildMarkdown(
  issue: JiraIssue,
  descriptionMd: string,
  commentsMd: string,
): string {
  const sections: string[] = [];

  sections.push(`# ${issue.key}: ${issue.fields.summary}`);
  sections.push("");

  if (descriptionMd) {
    sections.push("## Description");
    sections.push("");
    sections.push(descriptionMd);
    sections.push("");
  } else {
    sections.push("*No description provided.*");
    sections.push("");
  }

  if (commentsMd) {
    sections.push(commentsMd);
  }

  return sections.join("\n");
}
