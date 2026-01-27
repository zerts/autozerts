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
import { fetchMyIssues, groupIssuesBySprint, issueUrl } from "../services/jira";
import { getAllTasks } from "../utils/storage";
import type { JiraIssue } from "../types/jira";
import type { TaskState } from "../types/storage";
import { TASK_STATUS_LABELS } from "../types/storage";
import { TaskDetail } from "./TaskDetail";
import { ExecutionProgress } from "./ExecutionProgress";

const PRIORITY_ICONS: Record<string, { source: Icon; tintColor: Color }> = {
  Highest: { source: Icon.ExclamationMark, tintColor: Color.Red },
  High: { source: Icon.ArrowUp, tintColor: Color.Orange },
  Medium: { source: Icon.Minus, tintColor: Color.Yellow },
  Low: { source: Icon.ArrowDown, tintColor: Color.Blue },
  Lowest: { source: Icon.ChevronDown, tintColor: Color.SecondaryText },
};

function priorityIcon(name: string) {
  return (
    PRIORITY_ICONS[name] ?? { source: Icon.Dot, tintColor: Color.SecondaryText }
  );
}

function statusColor(categoryKey: string): Color {
  switch (categoryKey) {
    case "new":
      return Color.Blue;
    case "indeterminate":
      return Color.Yellow;
    case "done":
      return Color.Green;
    default:
      return Color.SecondaryText;
  }
}

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

export function TaskList() {
  const { data, isLoading, error } = usePromise(async () => {
    const [issues, tasks] = await Promise.all([
      fetchMyIssues(),
      getAllTasks(),
    ]);
    const grouped = groupIssuesBySprint(issues);
    // Build a map of jiraKey → active task
    const activeTaskMap = new Map<string, TaskState>();
    for (const t of tasks) {
      if (ACTIVE_STATUSES.has(t.status)) {
        activeTaskMap.set(t.jiraKey, t);
      }
    }
    return { ...grouped, activeTaskMap };
  });

  if (error) {
    showToast({
      style: Toast.Style.Failure,
      title: "Failed to fetch JIRA issues",
      message: error.message,
    });
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter tasks...">
      {data?.activeSprint && data.activeSprint.length > 0 && (
        <List.Section title="Active Sprint">
          {data.activeSprint.map((issue) => (
            <TaskListItem
              key={issue.key}
              issue={issue}
              activeTask={data.activeTaskMap.get(issue.key)}
            />
          ))}
        </List.Section>
      )}
      {data?.backlog && data.backlog.length > 0 && (
        <List.Section title="Backlog">
          {data.backlog.map((issue) => (
            <TaskListItem
              key={issue.key}
              issue={issue}
              activeTask={data.activeTaskMap.get(issue.key)}
            />
          ))}
        </List.Section>
      )}
      {!isLoading && !data?.activeSprint?.length && !data?.backlog?.length && (
        <List.EmptyView
          title="No tasks found"
          description="No JIRA issues assigned to you match the filter criteria."
          icon={Icon.CheckCircle}
        />
      )}
    </List>
  );
}

function TaskListItem({
  issue,
  activeTask,
}: {
  issue: JiraIssue;
  activeTask?: TaskState;
}) {
  const pIcon = priorityIcon(issue.fields.priority.name);
  const isActive = !!activeTask;

  const accessories: List.Item.Accessory[] = [];
  if (isActive) {
    accessories.push({
      tag: {
        value: TASK_STATUS_LABELS[activeTask.status],
        color: Color.Orange,
      },
    });
  }
  accessories.push({
    tag: {
      value: issue.fields.status.name,
      color: statusColor(issue.fields.status.statusCategory.key),
    },
  });
  accessories.push({ text: issue.fields.issuetype.name });

  // If a task is actively running, navigate straight to progress view
  const primaryTarget = isActive ? (
    <ExecutionProgress jiraKey={issue.key} />
  ) : (
    <TaskDetail issue={issue} />
  );

  return (
    <List.Item
      title={`[${issue.key}] ${issue.fields.summary}`}
      icon={pIcon}
      accessories={accessories}
      actions={
        <ActionPanel>
          <Action.Push
            title={isActive ? "View Progress" : "View Details"}
            icon={isActive ? Icon.Clock : Icon.Eye}
            target={primaryTarget}
          />
          {isActive && (
            <Action.Push
              title="View Details"
              icon={Icon.Eye}
              target={<TaskDetail issue={issue} />}
              shortcut={{ modifiers: ["cmd"], key: "d" }}
            />
          )}
          <Action.OpenInBrowser
            title="Open in Jira"
            url={issueUrl(issue.key)}
            shortcut={{ modifiers: ["cmd"], key: "o" }}
          />
          <Action.CopyToClipboard
            title="Copy Issue Key"
            content={issue.key}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
        </ActionPanel>
      }
    />
  );
}
