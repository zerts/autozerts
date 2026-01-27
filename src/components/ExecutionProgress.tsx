import { Detail, ActionPanel, Action, Icon, Color, showToast, Toast, launchCommand, LaunchType } from "@raycast/api";
import { useState, useEffect, useRef, useMemo } from "react";
import equal from "fast-deep-equal";
import { getTask, requestCancellation, sanitizeUnicode } from "../utils/storage";
import {
  TASK_STATUS_LABELS,
  type TaskState,
  type TaskStatus,
} from "../types/storage";

interface ExecutionProgressProps {
  jiraKey: string;
}

const PLAN_STATUS_ORDER: TaskStatus[] = [
  "initializing",
  "worktree_created",
  "dependencies_installed",
  "planning",
  "plan_complete",
];

const IMPL_STATUS_ORDER: TaskStatus[] = [
  "initializing",
  "worktree_created",
  "dependencies_installed",
  "implementing",
  "implementation_complete",
  "pushing",
  "pr_created",
  "complete",
];

const PLAN_THEN_IMPL_STATUS_ORDER: TaskStatus[] = [
  "initializing",
  "worktree_created",
  "dependencies_installed",
  "planning",
  "plan_complete",
  "implementing",
  "implementation_complete",
  "pushing",
  "pr_created",
  "complete",
];

function getStatusOrder(task: TaskState): TaskStatus[] {
  const isPlanPhase = task.status === "planning" || task.status === "plan_complete";
  const hasPassedPlan = task.progressLog.some((l) => l.includes("Plan complete"));

  if (isPlanPhase) return PLAN_STATUS_ORDER;
  if (hasPassedPlan) return PLAN_THEN_IMPL_STATUS_ORDER;
  return IMPL_STATUS_ORDER;
}

export function ExecutionProgress({ jiraKey }: ExecutionProgressProps) {
  const [task, setTask] = useState<TaskState | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const taskRef = useRef<TaskState | null>(null);

  useEffect(() => {
    // Initial fetch
    getTask(jiraKey).then((t) => {
      taskRef.current = t;
      setTask(t);
    });

    // Poll every 1s for responsive updates during Claude execution
    intervalRef.current = setInterval(async () => {
      const updated = await getTask(jiraKey);
      if (updated && !equal(updated, taskRef.current)) {
        taskRef.current = updated;
        setTask(updated);
      }
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [jiraKey]);
  
    const isTerminal = task ? ["complete", "error", "cancelled", "plan_complete"].includes(task.status) : false;
    const markdown = useMemo(() => task ? buildProgressMarkdown(task) : null, [task]);

  if (!task) {
    return <Detail isLoading markdown="Loading task state..." />;
  }

  return (
    <Detail
      isLoading={!isTerminal}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label
            title="Task"
            text={`${task.jiraKey}: ${task.jiraSummary}`}
          />
          <Detail.Metadata.Label title="Repository" text={task.repoName} />
          <Detail.Metadata.Label title="Branch" text={task.branchName} />
          <Detail.Metadata.TagList title="Status">
            <Detail.Metadata.TagList.Item
              text={TASK_STATUS_LABELS[task.status]}
              color={
                task.status === "complete"
                  ? Color.Green
                  : task.status === "plan_complete"
                    ? Color.Blue
                    : task.status === "error"
                      ? Color.Red
                      : task.status === "cancelled"
                        ? Color.SecondaryText
                        : Color.Yellow
              }
            />
          </Detail.Metadata.TagList>
          {task.costUsd !== undefined && (
            <Detail.Metadata.Label
              title="Cost"
              text={`$${task.costUsd.toFixed(2)}`}
            />
          )}
          <Detail.Metadata.Label
            title="Started"
            text={new Date(task.createdAt).toLocaleTimeString()}
          />
          <Detail.Metadata.Separator />
          {task.prUrl && (
            <Detail.Metadata.Link
              title="Pull Request"
              target={task.prUrl}
              text="Open PR"
            />
          )}
          <Detail.Metadata.Link
            title="JIRA"
            target={task.jiraUrl}
            text="Open in browser"
          />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          {task.status === "plan_complete" && (
            <Action
              title="Implement Plan"
              icon={Icon.Hammer}
              shortcut={{ modifiers: ["cmd"], key: "return" }}
              onAction={async () => {
                await launchCommand({
                  name: "run-orchestration",
                  type: LaunchType.UserInitiated,
                  context: { jiraKey },
                });
                await showToast({ style: Toast.Style.Animated, title: "Implementation started..." });
              }}
            />
          )}
          {!isTerminal && (
            <Action
              title="Cancel Task"
              icon={Icon.XMarkCircle}
              style={Action.Style.Destructive}
              shortcut={{ modifiers: ["cmd", "shift"], key: "x" }}
              onAction={async () => {
                await requestCancellation(jiraKey);
                await showToast({ style: Toast.Style.Animated, title: "Cancellation requested..." });
              }}
            />
          )}
          {task.status === "error" && task.error && (
            <Action.CopyToClipboard
              title="Copy Error"
              content={task.error}
              icon={Icon.Bug}
            />
          )}
          {task.prUrl && (
            <Action.OpenInBrowser
              title="Open Pull Request"
              url={task.prUrl}
              icon={Icon.Globe}
            />
          )}
          <Action.OpenInBrowser title="Open in Jira" url={task.jiraUrl} />
          {task.worktreePath && (
            <Action.Open
              title="Open Worktree in Editor"
              target={task.worktreePath}
              icon={Icon.Code}
              shortcut={{ modifiers: ["cmd"], key: "e" }}
            />
          )}
          {task.worktreePath && (
            <Action.Open
              title="Open Worktree in Terminal"
              target={task.worktreePath}
              application="Terminal"
              icon={Icon.Terminal}
              shortcut={{ modifiers: ["cmd"], key: "t" }}
            />
          )}
          <Action.CopyToClipboard
            title="Copy Worktree Path"
            content={task.worktreePath}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
          <Action.CopyToClipboard
            title="Copy Full Log"
            content={task.progressLog.join("\n")}
            shortcut={{ modifiers: ["cmd", "shift"], key: "l" }}
          />
        </ActionPanel>
      }
    />
  );
}

function buildProgressMarkdown(task: TaskState): string {
  const sections: string[] = [];

  sections.push(`# ${task.jiraKey}: ${task.jiraSummary}`);
  sections.push("");

  // Checklist with emoji — skip for feedback tasks (status not in any order)
  const isFeedback = task.status === "feedback_implementing";
  if (!isFeedback) {
    sections.push("## Progress");
    sections.push("");
    const statusOrder = getStatusOrder(task);
    const currentIndex = statusOrder.indexOf(task.status);
    const isError = task.status === "error";
    const isCancelled = task.status === "cancelled";

    for (const step of statusOrder) {
      const label = TASK_STATUS_LABELS[step];
      const stepIndex = statusOrder.indexOf(step);

      let emoji: string;
      if (isError || isCancelled) {
        // Find how far we got before the error/cancel
        const lastGoodIndex = isError
          ? currentIndex // error isn't in STATUS_ORDER, so currentIndex is -1
          : -1;
        if (lastGoodIndex < 0) {
          // Could not determine progress; mark all as unknown
          emoji = isError ? "🔴" : "⚪";
        } else if (stepIndex <= lastGoodIndex) {
          emoji = "✅";
        } else if (stepIndex === lastGoodIndex + 1) {
          emoji = isError ? "❌" : "⚪";
        } else {
          emoji = "⬜";
        }
      } else if (stepIndex < currentIndex) {
        emoji = "✅";
      } else if (stepIndex === currentIndex) {
        emoji = "🔄";
      } else {
        emoji = "⬜";
      }

      sections.push(`${emoji}  ${label}\n`);
    }

    // Show error/cancelled status at the end of the checklist
    if (isError) {
      sections.push(`❌  Error\n`);
    } else if (isCancelled) {
      sections.push(`⚪  Cancelled\n`);
    }
  }

  // Error message
  if (task.status === "error" && task.error) {
    sections.push("## Error");
    sections.push("");
    sections.push(`\`\`\`\n${task.error}\n\`\`\``);
    sections.push("");
  }

  // Full activity log with formatting by entry type
  if (task.progressLog.length > 0) {
    sections.push("## Activity Log");
    sections.push("");

    // Show the last 100 entries, newest first so updates are visible without scrolling
    const entries = task.progressLog.slice(-100).reverse();
    for (const entry of entries) {
      sections.push(formatLogEntry(entry));
    }

    if (task.progressLog.length > 100) {
      sections.push(
        `\n*... ${task.progressLog.length - 100} earlier entries omitted*`,
      );
    }
    sections.push("");
  }

  return sanitizeUnicode(sections.join("\n"));
}

/**
 * Format a log entry for markdown display.
 * Entries are tagged with brackets: [claude], [read], [edit], [bash], etc.
 */
function formatLogEntry(entry: string): string {
  // Strip the timestamp prefix for pattern matching, keep it for display
  const timestampMatch = entry.match(/^\[([^\]]+)\]\s*(.*)/s);
  if (!timestampMatch) return `- ${entry}`;

  const timestamp = timestampMatch[1];
  const body = timestampMatch[2];

  // Match the tag: [claude], [read], [edit], [bash], [tool], etc.
  const tagMatch = body.match(/^\[([a-z]+)\]\s*(.*)/s);
  if (!tagMatch) {
    // Pipeline messages (no tag) — plain bullet
    return `- \`${timestamp}\` ${body}`;
  }

  const tag = tagMatch[1];
  const content = tagMatch[2];

  switch (tag) {
    case "claude":
      // Claude's reasoning/text — blockquote
      return `- \`${timestamp}\` **Claude:** ${content}`;

    case "read":
      return `- \`${timestamp}\` Read \`${content}\``;

    case "edit":
      return `- \`${timestamp}\` Edit \`${content}\``;

    case "write":
      return `- \`${timestamp}\` Write \`${content}\``;

    case "bash":
      return `- \`${timestamp}\` Bash: \`${content.slice(0, 120)}${content.length > 120 ? "..." : ""}\``;

    case "glob":
      return `- \`${timestamp}\` Glob: \`${content}\``;

    case "grep":
      return `- \`${timestamp}\` Grep: \`${content}\``;

    case "task":
      return `- \`${timestamp}\` Subagent: ${content}`;

    case "search":
      return `- \`${timestamp}\` Web search: ${content}`;

    case "fetch":
      return `- \`${timestamp}\` Fetch: ${content}`;

    case "todo":
      return `- \`${timestamp}\` ${content}`;

    case "init":
      return `- \`${timestamp}\` ${content}`;

    case "summary":
      return `- \`${timestamp}\` ${content}`;

    case "result":
      return `- \`${timestamp}\` **Result:** ${content}`;

    default:
      return `- \`${timestamp}\` [${tag}] ${content}`;
  }
}
