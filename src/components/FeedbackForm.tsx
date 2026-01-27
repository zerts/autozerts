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
import type { GitHubPullRequest } from "../types/github";
import type { TaskState } from "../types/storage";
import { getConfig } from "../utils/preferences";
import { getTask, saveOrchestrationParams, updateTaskStatus, appendProgressLog } from "../utils/storage";
import { parseRepoFullName } from "../services/github";
import { ExecutionProgress } from "./ExecutionProgress";

interface FeedbackFormProps {
  pr: GitHubPullRequest;
  taskState?: TaskState;
}

export function FeedbackForm({ pr, taskState }: FeedbackFormProps) {
  const config = getConfig();
  const { push } = useNavigation();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(values: {
    feedbackText: string;
    autoImplement: boolean;
    postAsComment: boolean;
  }) {
    if (!values.feedbackText.trim()) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Feedback text is required",
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
        const jiraKeyMatch = pr.title.match(/^([A-Z]+-\d+)/);
        const jiraKey = jiraKeyMatch?.[1] ?? `PR-${pr.number}`;
        task = createInitialTaskState({
          jiraKey,
          jiraSummary: pr.title,
          jiraUrl: pr.html_url,
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
        await updateTaskStatus(task.jiraKey, "feedback_implementing");
        await appendProgressLog(task.jiraKey, "Feedback submitted — starting implementation...");

        // Navigate to progress view
        push(<ExecutionProgress jiraKey={task.jiraKey} />);

        // Save params and launch background orchestration command
        await saveOrchestrationParams(task.jiraKey, {
          mode: "feedback",
          jiraKey: task.jiraKey,
          repoName: repo.name,
          feedbackText: values.feedbackText,
          postAsComment: values.postAsComment,
        });
        await launchCommand({
          name: "run-orchestration",
          type: LaunchType.UserInitiated,
          context: { jiraKey: task.jiraKey },
        });

        await showToast({
          style: Toast.Style.Animated,
          title: "Feedback implementation started",
        });
      } else {
        // Just post the comment without auto-implementing
        if (values.postAsComment) {
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
