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
import { fetchMyIssues } from "../services/linear";
import { getPlanFilePath } from "../services/worktree";
import { getAllTasks } from "../utils/storage";
import { generateBranchName } from "../utils/branch-naming";
import type { LinearIssue } from "../types/linear";
import type { TaskState } from "../types/storage";
import { TASK_STATUS_LABELS } from "../types/storage";
import { TaskDetail } from "./TaskDetail";
import { ExecutionProgress } from "./ExecutionProgress";

function issueTypeIcon(issue: LinearIssue): { source: Icon; tintColor: Color } {
  const isBug = issue.labels.nodes.some((l) => l.name.toLowerCase() === "bug");
  return isBug
    ? { source: Icon.Bug, tintColor: Color.Red }
    : { source: Icon.CheckCircle, tintColor: Color.Blue };
}

function priorityAccessory(priorityLabel: string): {
  icon: { source: Icon; tintColor: Color };
  tooltip: string;
} {
  let icon: { source: Icon; tintColor: Color };
  switch (priorityLabel.toLowerCase()) {
    case "urgent":
      icon = { source: Icon.ExclamationMark, tintColor: Color.Red };
      break;
    case "high":
      icon = { source: Icon.ArrowUp, tintColor: Color.Orange };
      break;
    case "medium":
      icon = { source: Icon.Minus, tintColor: Color.Yellow };
      break;
    case "low":
      icon = { source: Icon.ArrowDown, tintColor: Color.Blue };
      break;
    default:
      icon = { source: Icon.Dot, tintColor: Color.SecondaryText };
      break;
  }
  return { icon, tooltip: priorityLabel };
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

/** Matches release labels like "iOS v1.2.3", "Android v2.0", "Web v1.0.0-beta" */
const RELEASE_LABEL_RE = /^.+\s+v\d+(\.\d+)*(-\S+)?$/;

function isReleaseLabel(name: string): boolean {
  return RELEASE_LABEL_RE.test(name);
}

function hasAiReadyLabel(issue: LinearIssue): boolean {
  return issue.labels.nodes.some((l) => l.name === "AI Ready");
}

const STATE_TYPE_ORDER: Record<string, number> = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
  cancelled: 5,
};

function findDeployedUrl(issue: LinearIssue): string | null {
  const comments = issue.comments?.nodes;
  if (!comments) return null;
  const pattern = /deployed to (https?:\/\/\S+)/i;
  let url: string | null = null;
  for (const c of comments) {
    const match = c.body.match(pattern);
    if (match) {
      url = match[1];
    }
  }
  return url;
}

export function TaskList() {
  const { data, isLoading, error } = usePromise(async () => {
    const fs = await import("fs/promises");
    const [issues, tasks] = await Promise.all([fetchMyIssues(), getAllTasks()]);

    // Build a map of issueKey → task (any status)
    const taskMap = new Map<string, TaskState>();
    for (const t of tasks) {
      taskMap.set(t.issueKey, t);
    }

    // Check which issues have plan files
    const planExistsMap = new Map<string, boolean>();
    await Promise.all(
      issues.map(async (issue) => {
        const branchName = generateBranchName(issue.title, issue.identifier);
        const planPath = getPlanFilePath(branchName);
        try {
          await fs.access(planPath);
          planExistsMap.set(issue.identifier, true);
        } catch {
          planExistsMap.set(issue.identifier, false);
        }
      }),
    );

    // Group issues by their Linear state, one section per state
    const groupMap = new Map<
      string,
      { stateName: string; stateType: string; issues: LinearIssue[] }
    >();
    for (const issue of issues) {
      const key = issue.state.id;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          stateName: issue.state.name,
          stateType: issue.state.type,
          issues: [],
        });
      }
      groupMap.get(key)!.issues.push(issue);
    }

    // Within each group, AI Ready issues float to the top
    for (const group of groupMap.values()) {
      group.issues.sort(
        (a, b) => Number(hasAiReadyLabel(b)) - Number(hasAiReadyLabel(a)),
      );
    }

    // Sort groups: todo types first, then started, completed, cancelled
    const groups = [...groupMap.values()].sort((a, b) => {
      const pa = STATE_TYPE_ORDER[a.stateType] ?? 99;
      const pb = STATE_TYPE_ORDER[b.stateType] ?? 99;
      return pa - pb;
    });

    // Detect deployed URLs from Linear comments
    const deployedUrlMap = new Map<string, string | null>();
    for (const issue of issues) {
      deployedUrlMap.set(issue.identifier, findDeployedUrl(issue));
    }

    return {
      groups,
      taskMap,
      planExistsMap,
      deployedUrlMap,
    };
  });

  if (error) {
    showToast({
      style: Toast.Style.Failure,
      title: "Failed to fetch Linear issues",
      message: error.message,
    });
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter tasks...">
      {data?.groups.map(({ stateName, issues }) => (
        <List.Section key={stateName} title={stateName}>
          {issues.map((issue) => (
            <TaskListItem
              key={issue.identifier}
              issue={issue}
              task={data.taskMap.get(issue.identifier)}
              planExists={data.planExistsMap.get(issue.identifier) ?? false}
              deployedUrl={data.deployedUrlMap.get(issue.identifier) ?? null}
            />
          ))}
        </List.Section>
      ))}
      {!isLoading && !data?.groups.length && (
        <List.EmptyView
          title="No tasks found"
          description="No Linear issues assigned to you in the active cycle."
          icon={Icon.CheckCircle}
        />
      )}
    </List>
  );
}

function TaskListItem({
  issue,
  task,
  planExists,
  deployedUrl,
}: {
  issue: LinearIssue;
  task?: TaskState;
  planExists: boolean;
  deployedUrl: string | null;
}) {
  const typeIcon = issueTypeIcon(issue);
  const branchName = generateBranchName(issue.title, issue.identifier);
  const planFilePath = getPlanFilePath(branchName);

  const accessories: List.Item.Accessory[] = [];
  if (deployedUrl) {
    accessories.push({
      icon: { source: Icon.Globe, tintColor: Color.Purple },
      tooltip: "Preview available",
    });
  }
  if (task) {
    accessories.push({
      icon: taskStatusIcon(task.status),
      tooltip: TASK_STATUS_LABELS[task.status],
    });
  }
  accessories.push(priorityAccessory(issue.priorityLabel));
  const isAiReady = hasAiReadyLabel(issue);
  if (isAiReady) {
    accessories.push({
      icon: { source: Icon.Stars, tintColor: Color.Purple },
      tooltip: "AI Ready",
    });
  }
  for (const label of issue.labels.nodes) {
    if (isReleaseLabel(label.name)) continue;
    if (label.name.toLowerCase() === "bug") continue;
    if (label.name === "AI Ready") continue;
    accessories.push({
      tag: {
        value: label.name,
        color: label.color,
      },
    });
  }
  accessories.push({ text: issue.identifier });

  return (
    <List.Item
      title={issue.title}
      icon={typeIcon}
      accessories={accessories}
      actions={
        <ActionPanel>
          <Action.Push
            title="View Details"
            icon={Icon.Eye}
            target={<TaskDetail issue={issue} />}
          />
          {planExists && (
            <Action.Open
              title="Open Plan in VS Code"
              icon={Icon.Code}
              target={planFilePath}
              application="Code"
            />
          )}
          {task && (
            <Action.Push
              title="View Progress"
              icon={Icon.CircleProgress}
              target={<ExecutionProgress issueKey={issue.identifier} />}
            />
          )}
          {deployedUrl && (
            <Action.Open
              title="Open Dev Build"
              icon={Icon.Globe}
              target={deployedUrl}
              application="Helium"
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
            title="Copy Issue Key"
            content={issue.identifier}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
        </ActionPanel>
      }
    />
  );
}
