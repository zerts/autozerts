import { LaunchProps, showToast, Toast } from "@raycast/api";
import {
  getOrchestrationParams,
  saveOrchestrationParams,
  clearOrchestrationParams,
  isCancellationRequested,
  clearCancellation,
  getTask,
  appendProgressLog,
  updateTaskStatus,
} from "./utils/storage";
import { getConfig } from "./utils/preferences";
import { orchestrateImplementation, orchestratePlan, orchestrateFeedback } from "./services/claude";

interface LaunchContext {
  jiraKey: string;
}

export default async function RunOrchestration(
  props: LaunchProps<{ launchContext: LaunchContext }>,
) {
  const jiraKey = props.launchContext?.jiraKey;
  if (!jiraKey) {
    await showToast({ style: Toast.Style.Failure, title: "No jiraKey in launch context" });
    return;
  }

  const params = await getOrchestrationParams(jiraKey);
  if (!params) {
    await showToast({ style: Toast.Style.Failure, title: "No orchestration params found", message: jiraKey });
    return;
  }

  const abortController = new AbortController();

  // Poll for cancellation every 2s
  const cancelInterval = setInterval(async () => {
    if (await isCancellationRequested(jiraKey)) {
      abortController.abort();
      clearInterval(cancelInterval);
    }
  }, 2000);

  try {
    if (params.mode === "plan") {
      const config = getConfig();
      const repo = config.repos.find((r) => r.name === params.repoName);
      if (!repo) {
        await showToast({ style: Toast.Style.Failure, title: "Repository not found", message: params.repoName });
        return;
      }

      await orchestratePlan({
        issue: params.issue,
        repo,
        branchName: params.branchName,
        baseBranch: params.baseBranch,
        userInstructions: params.userInstructions,
        abortController,
      });

      // Keep params but switch mode so "Implement Plan" can re-launch
      await saveOrchestrationParams(jiraKey, {
        mode: "implement",
        issue: params.issue,
        repoName: params.repoName,
        branchName: params.branchName,
        baseBranch: params.baseBranch,
        userInstructions: params.userInstructions,
      });
    } else if (params.mode === "implement") {
      const config = getConfig();
      const repo = config.repos.find((r) => r.name === params.repoName);
      if (!repo) {
        await showToast({ style: Toast.Style.Failure, title: "Repository not found", message: params.repoName });
        return;
      }

      await orchestrateImplementation({
        issue: params.issue,
        repo,
        branchName: params.branchName,
        baseBranch: params.baseBranch,
        userInstructions: params.userInstructions,
        abortController,
      });
    } else if (params.mode === "feedback") {
      const config = getConfig();
      const repo = config.repos.find((r) => r.name === params.repoName);
      if (!repo) {
        await showToast({ style: Toast.Style.Failure, title: "Repository not found", message: params.repoName });
        return;
      }

      const task = await getTask(params.jiraKey);
      if (!task) {
        await showToast({ style: Toast.Style.Failure, title: "Task state not found", message: params.jiraKey });
        return;
      }

      await orchestrateFeedback({
        task,
        repo,
        feedbackText: params.feedbackText,
        postAsComment: params.postAsComment,
        abortController,
      });
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      await updateTaskStatus(jiraKey, "cancelled");
      await appendProgressLog(jiraKey, "Task cancelled by user");
      await showToast({ style: Toast.Style.Failure, title: "Task Cancelled", message: jiraKey });
    } else {
      throw error;
    }
  } finally {
    clearInterval(cancelInterval);
    // After plan mode, params are kept (switched to implement) for "Implement Plan".
    // For all other modes, clean up.
    if (params.mode !== "plan") {
      await clearOrchestrationParams(jiraKey);
    }
    await clearCancellation(jiraKey);
  }
}
