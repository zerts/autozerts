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
import type { TaskState } from "../types/storage";
import { getConfig } from "../utils/preferences";
import {
  saveOrchestrationParams,
  updateTaskStatus,
  appendProgressLog,
} from "../utils/storage";
import { ExecutionProgress } from "./ExecutionProgress";

interface PlanFeedbackFormProps {
  task: TaskState;
}

export function PlanFeedbackForm({ task }: PlanFeedbackFormProps) {
  const config = getConfig();
  const { push } = useNavigation();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(values: { feedbackText: string }) {
    if (!values.feedbackText.trim()) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Please provide feedback for the plan",
      });
      return;
    }

    setIsSubmitting(true);

    try {
      const repo = config.repos.find((r) => r.name === task.repoName);
      if (!repo) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Repository not found in config",
          message: task.repoName,
        });
        setIsSubmitting(false);
        return;
      }

      // Mark task as planning
      await updateTaskStatus(task.issueKey, "planning");
      await appendProgressLog(
        task.issueKey,
        "Plan feedback submitted — updating plan...",
      );

      // Navigate to progress view
      push(<ExecutionProgress issueKey={task.issueKey} />);

      // Build a minimal issue object for the orchestration
      const minimalIssue = {
        id: "",
        identifier: task.issueKey,
        title: task.issueSummary,
        description: null,
        state: { id: "", name: "In Progress", type: "started" },
        priority: 2,
        priorityLabel: "Medium",
        labels: { nodes: [] },
        assignee: null,
        creator: null,
        cycle: null,
        comments: { nodes: [] },
        createdAt: "",
        updatedAt: "",
        url: task.issueUrl,
      };

      await saveOrchestrationParams(task.issueKey, {
        mode: "plan",
        issue: minimalIssue as never,
        repoName: repo.name,
        branchName: task.branchName,
        baseBranch: task.baseBranch,
        userInstructions: values.feedbackText,
        updateExistingPlan: true,
      });

      await launchCommand({
        name: "run-orchestration",
        type: LaunchType.UserInitiated,
        context: { issueKey: task.issueKey },
      });

      await showToast({
        style: Toast.Style.Animated,
        title: "Plan update started",
      });
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
            title="Update Plan"
            icon={Icon.Document}
            onSubmit={handleSubmit}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Task"
        text={`${task.issueKey}: ${task.issueSummary}`}
      />

      <Form.Description title="Repository" text={task.repoName} />

      <Form.TextArea
        id="feedbackText"
        title="Plan Feedback"
        placeholder="Describe what changes are needed to the plan..."
      />
    </Form>
  );
}
