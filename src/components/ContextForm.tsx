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
import { useState, useEffect } from "react";
import type { LinearIssue } from "../types/linear";
import { getConfig } from "../utils/preferences";
import { generateBranchName } from "../utils/branch-naming";
import { getWorktreePath, getPlanFilePath } from "../services/worktree";
import {
  createInitialTaskState,
  saveTask,
  saveOrchestrationParams,
} from "../utils/storage";
import { ExecutionProgress } from "./ExecutionProgress";

interface ContextFormProps {
  issue: LinearIssue;
  descriptionMarkdown: string;
}

function findDefaultRepo(
  title: string,
  repos: ReturnType<typeof getConfig>["repos"],
): string | undefined {
  const lower = title.toLowerCase();
  const repo = repos.find((r) =>
    r.issuePrefixes.some((p) => lower.includes(p.toLowerCase())),
  );
  return repo?.name;
}

export function ContextForm({ issue, descriptionMarkdown }: ContextFormProps) {
  const config = getConfig();
  const { push } = useNavigation();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [planModeEnabled, setPlanModeEnabled] = useState(false);
  const [existingPlanExists, setExistingPlanExists] = useState(false);

  const defaultRepo = findDefaultRepo(issue.title, config.repos);
  const contextSummary = buildContextSummary(issue, descriptionMarkdown);

  // Check if plan file exists when plan mode is enabled
  useEffect(() => {
    if (!planModeEnabled) {
      setExistingPlanExists(false);
      return;
    }

    async function checkPlanExists() {
      const branchName = generateBranchName(issue.title, issue.identifier);
      const planPath = getPlanFilePath(branchName);
      try {
        const fs = await import("fs/promises");
        await fs.access(planPath);
        setExistingPlanExists(true);
      } catch {
        setExistingPlanExists(false);
      }
    }

    checkPlanExists();
  }, [planModeEnabled, issue.title, issue.identifier]);

  async function handleSubmit(values: {
    repoName: string;
    baseBranch: string;
    extraInstructions: string;
    planModeFirst: boolean;
    updateExistingPlan: boolean;
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

      const branchName = generateBranchName(issue.title, issue.identifier);
      const baseBranch = values.baseBranch || repo.defaultBranch;
      const wtPath = getWorktreePath(repo.name, branchName);

      // Create initial task state in file storage
      const taskState = createInitialTaskState({
        issueKey: issue.identifier,
        issueSummary: issue.title,
        issueUrl: issue.url,
        repoName: repo.name,
        branchName,
        worktreePath: wtPath,
        baseBranch,
      });
      await saveTask(taskState);

      // Navigate to progress view
      push(<ExecutionProgress issueKey={issue.identifier} />);

      // Write orch params to file, then spawn the worker as a detached process.
      // Each task gets its own independent process — no Raycast timeout, no
      // singleton constraint, unlimited parallelism.
      const mode = values.planModeFirst ? "plan" : "implement";
      await saveOrchestrationParams(issue.identifier, {
        mode,
        issue,
        repoName: repo.name,
        branchName,
        baseBranch,
        userInstructions: values.extraInstructions,
        ...(mode === "plan" && {
          updateExistingPlan: values.updateExistingPlan,
        }),
      } as import("../types/storage").OrchestrationParams);

      await launchCommand({
        name: "run-orchestration",
        type: LaunchType.UserInitiated,
        context: { issueKey: issue.identifier },
      });

      await showToast({
        style: Toast.Style.Animated,
        title: values.planModeFirst
          ? "Planning started"
          : "Implementation started",
        message: `${issue.identifier} → ${repo.name}`,
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
        text={`${issue.identifier}: ${issue.title}`}
      />

      <Form.Dropdown
        id="repoName"
        title="Target Repository"
        defaultValue={defaultRepo}
      >
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
        onChange={setPlanModeEnabled}
      />

      {planModeEnabled && existingPlanExists && (
        <Form.Checkbox
          id="updateExistingPlan"
          label="Update existing plan"
          defaultValue={true}
        />
      )}
    </Form>
  );
}

function buildContextSummary(
  issue: LinearIssue,
  descriptionMd: string,
): string {
  const parts: string[] = [];
  parts.push(`Linear: ${issue.identifier} (${issue.priorityLabel})`);
  parts.push(
    `Description: ${descriptionMd ? `${descriptionMd.length} chars` : "none"}`,
  );
  if (issue.comments?.nodes?.length) {
    parts.push(`Comments: ${issue.comments.nodes.length}`);
  }
  return parts.join("\n");
}
