import { LaunchProps, showToast, Toast } from "@raycast/api";

async function safeShowToast(options: Toast.Options): Promise<void> {
  try {
    await showToast(options);
  } catch {
    // Toast API unavailable in background mode — ignore
  }
}
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
import {
  orchestrateImplementation,
  orchestratePlan,
  orchestrateFeedback,
} from "./services/claude";

interface LaunchContext {
  issueKey: string;
}

export default async function RunOrchestration(
  props: LaunchProps<{ launchContext: LaunchContext }>,
) {
  const issueKey = props.launchContext?.issueKey;
  if (!issueKey) {
    await safeShowToast({
      style: Toast.Style.Failure,
      title: "No issueKey in launch context",
    });
    return;
  }

  const params = await getOrchestrationParams(issueKey);
  if (!params) {
    await safeShowToast({
      style: Toast.Style.Failure,
      title: "No orchestration params found",
      message: issueKey,
    });
    return;
  }

  const abortController = new AbortController();

  // Poll for cancellation every 2s
  const cancelInterval = setInterval(async () => {
    if (await isCancellationRequested(issueKey)) {
      abortController.abort();
      clearInterval(cancelInterval);
    }
  }, 2000);

  try {
    if (params.mode === "plan") {
      const config = getConfig();
      const repo = config.repos.find((r) => r.name === params.repoName);
      if (!repo) {
        await safeShowToast({
          style: Toast.Style.Failure,
          title: "Repository not found",
          message: params.repoName,
        });
        return;
      }

      await orchestratePlan({
        issue: params.issue,
        repo,
        branchName: params.branchName,
        baseBranch: params.baseBranch,
        userInstructions: params.userInstructions,
        abortController,
        updateExistingPlan: params.updateExistingPlan,
      });

      // Keep params but switch mode so "Implement Plan" can re-launch
      await saveOrchestrationParams(issueKey, {
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
        await safeShowToast({
          style: Toast.Style.Failure,
          title: "Repository not found",
          message: params.repoName,
        });
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
        await safeShowToast({
          style: Toast.Style.Failure,
          title: "Repository not found",
          message: params.repoName,
        });
        return;
      }

      const task = await getTask(params.issueKey);
      if (!task) {
        await safeShowToast({
          style: Toast.Style.Failure,
          title: "Task state not found",
          message: params.issueKey,
        });
        return;
      }

      await orchestrateFeedback({
        task,
        repo,
        feedbackText: params.feedbackText,
        postAsComment: params.postAsComment,
        newCommentsContext: params.newCommentsContext,
        abortController,
      });
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      await updateTaskStatus(issueKey, "cancelled");
      await appendProgressLog(issueKey, "Task cancelled by user");
      await safeShowToast({
        style: Toast.Style.Failure,
        title: "Task Cancelled",
        message: issueKey,
      });
    } else {
      throw error;
    }
  } finally {
    clearInterval(cancelInterval);
    // After plan mode, params are kept (switched to implement) for "Implement Plan".
    // For all other modes, clean up.
    if (params.mode !== "plan") {
      await clearOrchestrationParams(issueKey);
    }
    await clearCancellation(issueKey);
  }
}
