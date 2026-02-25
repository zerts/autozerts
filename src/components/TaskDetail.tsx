import { Detail, ActionPanel, Action, Icon, Color } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import type { LinearIssue } from "../types/linear";
import { getPlanFilePath } from "../services/worktree";
import { generateBranchName } from "../utils/branch-naming";
import { getTask } from "../utils/storage";
import { ContextForm } from "./ContextForm";
import { PlanFeedbackForm } from "./PlanFeedbackForm";

interface TaskDetailProps {
  issue: LinearIssue;
}

export function TaskDetail({ issue }: TaskDetailProps) {
  const descriptionMd = issue.description ?? "";
  const commentsMd = buildCommentsMd(issue);
  const markdown = buildMarkdown(issue, descriptionMd, commentsMd);

  const branchName = generateBranchName(issue.title, issue.identifier);
  const planFilePath = getPlanFilePath(branchName);

  const { data: planData } = usePromise(async () => {
    const fs = await import("fs/promises");
    let planExists = false;
    try {
      await fs.access(planFilePath);
      planExists = true;
    } catch {
      // Plan doesn't exist
    }
    const task = await getTask(issue.identifier);
    return { planExists, task };
  });

  const planExists = planData?.planExists ?? false;
  const task = planData?.task;

  return (
    <Detail
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Key" text={issue.identifier} />
          <Detail.Metadata.Label
            title="Priority"
            text={issue.priorityLabel}
          />
          <Detail.Metadata.TagList title="Status">
            <Detail.Metadata.TagList.Item
              text={issue.state.name}
              color={
                issue.state.type === "completed"
                  ? Color.Green
                  : issue.state.type === "started"
                    ? Color.Yellow
                    : Color.Blue
              }
            />
          </Detail.Metadata.TagList>
          {issue.cycle && (
            <Detail.Metadata.Label
              title="Cycle"
              text={issue.cycle.name ?? `Cycle ${issue.cycle.number}`}
            />
          )}
          <Detail.Metadata.Separator />
          {issue.comments?.nodes?.length !== undefined && (
            <Detail.Metadata.Label
              title="Comments"
              text={`${issue.comments.nodes.length}`}
            />
          )}
          <Detail.Metadata.Link
            title="Linear"
            target={issue.url}
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
          {planExists && task && (
            <Action.Push
              title="Update Plan"
              icon={Icon.Pencil}
              target={<PlanFeedbackForm task={task} />}
            />
          )}
          {planExists && (
            <Action.Open
              title="Open Plan in VS Code"
              icon={Icon.Code}
              target={planFilePath}
              application="Code"
            />
          )}
          <Action.Open
            title="Open in Linear"
            icon={{ source: "linear.svg" }}
            target={issue.url}
            application="Linear"
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

function buildCommentsMd(issue: LinearIssue): string {
  const comments = issue.comments?.nodes;
  if (!comments || comments.length === 0) return "";

  const sections: string[] = [];
  sections.push("## Comments");
  sections.push("");
  for (const comment of comments) {
    const author = comment.user?.name ?? "Unknown";
    const date = new Date(comment.createdAt).toLocaleDateString();
    sections.push(`**${author}** (${date}):`);
    sections.push(comment.body);
    sections.push("");
  }
  return sections.join("\n");
}

function buildMarkdown(
  issue: LinearIssue,
  descriptionMd: string,
  commentsMd: string,
): string {
  const sections: string[] = [];

  sections.push(`# ${issue.identifier}: ${issue.title}`);
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
