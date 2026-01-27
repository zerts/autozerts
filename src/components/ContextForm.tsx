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
import type { JiraIssue } from "../types/jira";
import { getConfig } from "../utils/preferences";
import { generateBranchName } from "../utils/branch-naming";
import { getWorktreePath } from "../services/worktree";
import { createInitialTaskState, saveTask, saveOrchestrationParams } from "../utils/storage";
import { issueUrl } from "../services/jira";
import { ExecutionProgress } from "./ExecutionProgress";

interface ContextFormProps {
  issue: JiraIssue;
  descriptionMarkdown: string;
}

export function ContextForm({ issue, descriptionMarkdown }: ContextFormProps) {
  const config = getConfig();
  const { push } = useNavigation();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const contextSummary = buildContextSummary(issue, descriptionMarkdown);

  async function handleSubmit(values: {
    repoName: string;
    baseBranch: string;
    extraInstructions: string;
    planModeFirst: boolean;
  }) {
    setIsSubmitting(true);

    try {
      const repo = config.repos.find((r) => r.name === values.repoName);
      if (!repo) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Repository not found",
        });
        setIsSubmitting(false);
        return;
      }

      // Check repo exists locally
      const fs = await import("fs/promises");
      try {
        await fs.access(repo.localPath);
      } catch {
        await showToast({
          style: Toast.Style.Failure,
          title: "Repository not found on disk",
          message: repo.localPath,
        });
        setIsSubmitting(false);
        return;
      }

      const branchName = generateBranchName(issue.fields.summary, issue.key);
      const baseBranch = values.baseBranch || repo.defaultBranch;
      const wtPath = getWorktreePath(repo.name, branchName);

      // Create initial task state
      const taskState = createInitialTaskState({
        jiraKey: issue.key,
        jiraSummary: issue.fields.summary,
        jiraUrl: issueUrl(issue.key),
        repoName: repo.name,
        branchName,
        worktreePath: wtPath,
        baseBranch,
      });
      await saveTask(taskState);

      // Navigate to progress view
      push(<ExecutionProgress jiraKey={issue.key} />);

      // Save params and launch background orchestration command
      const mode = values.planModeFirst ? "plan" : "implement";
      await saveOrchestrationParams(issue.key, {
        mode,
        issue,
        repoName: repo.name,
        branchName,
        baseBranch,
        userInstructions: values.extraInstructions,
      } as import("../types/storage").OrchestrationParams);
      await launchCommand({
        name: "run-orchestration",
        type: LaunchType.UserInitiated,
        context: { jiraKey: issue.key },
      });

      await showToast({
        style: Toast.Style.Animated,
        title: values.planModeFirst ? "Planning started" : "Implementation started",
        message: `${issue.key} → ${repo.name}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to start",
        message,
      });
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
            title="Launch Claude Code"
            icon={Icon.Hammer}
            onSubmit={handleSubmit}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Task"
        text={`${issue.key}: ${issue.fields.summary}`}
      />

      <Form.Dropdown id="repoName" title="Target Repository">
        {config.repos.map((repo) => (
          <Form.Dropdown.Item
            key={repo.name}
            value={repo.name}
            title={repo.name}
          />
        ))}
      </Form.Dropdown>

      <Form.TextField
        id="baseBranch"
        title="Base Branch"
        placeholder={`Leave empty for repo default`}
      />

      <Form.Separator />

      <Form.Description title="Gathered Context" text={contextSummary} />

      <Form.TextArea
        id="extraInstructions"
        title="Extra Instructions"
        placeholder="Any additional context or instructions for Claude..."
      />

      <Form.Checkbox
        id="planModeFirst"
        label="Plan Mode first"
        defaultValue={false}
      />
    </Form>
  );
}

function buildContextSummary(issue: JiraIssue, descriptionMd: string): string {
  const parts: string[] = [];
  parts.push(
    `JIRA: ${issue.key} (${issue.fields.issuetype.name}, ${issue.fields.priority.name})`,
  );
  parts.push(
    `Description: ${descriptionMd ? `${descriptionMd.length} chars` : "none"}`,
  );
  if (issue.fields.comment?.total) {
    parts.push(`JIRA comments: ${issue.fields.comment.total}`);
  }
  return parts.join("\n");
}
