import { getPreferenceValues, environment } from "@raycast/api";
import { config } from "dotenv";
import fs from "fs";
import path from "path";
import type {
  AppConfig,
  RaycastPreferences,
  RepoConfig,
} from "../types/preferences";

let cachedConfig: AppConfig | null = null;

function loadEnv(): Record<string, string> {
  const candidates = [
    path.resolve(environment.assetsPath, "..", ".env"),
    "/Users/zerts/Work/autozerts/raycast-extension/.env",
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const result = config({ path: candidate });
      return (result.parsed ?? {}) as Record<string, string>;
    }
  }

  const result = config();
  return (result.parsed ?? {}) as Record<string, string>;
}

function parseRepos(raw: string | undefined): RepoConfig[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (
          r: unknown,
        ): r is { name: string; localPath: string; defaultBranch?: string } =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as RepoConfig).name === "string" &&
          typeof (r as RepoConfig).localPath === "string",
      )
      .map((r) => ({
        name: r.name,
        localPath: r.localPath,
        defaultBranch: r.defaultBranch ?? "main",
      }));
  } catch {
    return [];
  }
}

export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const env = loadEnv();
  const prefs = getPreferenceValues<RaycastPreferences>();

  cachedConfig = {
    jiraBaseUrl: env.JIRA_BASE_URL ?? "",
    jiraEmail: env.JIRA_EMAIL ?? "",
    jiraApiToken: env.JIRA_API_TOKEN ?? "",
    jiraProjectKeys: (env.JIRA_PROJECT_KEYS ?? "").split(",").filter(Boolean),
    githubToken: env.GITHUB_TOKEN ?? "",
    githubOwner: env.GITHUB_OWNER ?? "",
    repos: parseRepos(env.REPOS),
    worktreeBasePath: env.WORKTREE_BASE_PATH ?? "",
    planFilesPath: env.PLAN_FILES_PATH ?? "",
    claudeMaxTurns: parseInt(env.CLAUDE_MAX_TURNS ?? "200", 10),
    claudeMaxBudgetUsd: parseFloat(env.CLAUDE_MAX_BUDGET_USD ?? "5.00"),
    claudeModel:
      prefs.claudeModel ?? env.CLAUDE_MODEL ?? "claude-sonnet-4-5-20250929",
    gitAuthorName: env.GIT_AUTHOR_NAME ?? "AutoZerts",
    gitAuthorEmail:
      env.GIT_AUTHOR_EMAIL ?? "autozerts@noreply.github.com",
  };

  return cachedConfig;
}

export function clearConfigCache(): void {
  cachedConfig = null;
}
