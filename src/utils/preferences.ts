import { getPreferenceValues, environment } from "@raycast/api";
import { config } from "dotenv";
import fs from "fs";
import path from "path";
import type {
  AppConfig,
  RaycastPreferences,
  RepoConfig,
} from "../types/preferences";
import { FALLBACK_ENV_PATH } from "../config";

let cachedConfig: AppConfig | null = null;

function loadEnv(): Record<string, string> {
  const candidates = [
    path.resolve(environment.assetsPath, "..", ".env"),
    FALLBACK_ENV_PATH,
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
        ): r is {
          name: string;
          localPath: string;
          defaultBranch?: string;
          issuePrefixes?: string[];
        } =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as RepoConfig).name === "string" &&
          typeof (r as RepoConfig).localPath === "string",
      )
      .map((r) => ({
        name: r.name,
        localPath: r.localPath,
        defaultBranch: r.defaultBranch ?? "main",
        issuePrefixes: Array.isArray(r.issuePrefixes)
          ? r.issuePrefixes.filter((p: unknown) => typeof p === "string")
          : [],
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
    linearApiKey: env.LINEAR_API_KEY ?? "",
    githubToken: env.GITHUB_TOKEN ?? "",
    githubOwner: env.GITHUB_OWNER ?? "",
    repos: parseRepos(env.REPOS),
    extensionQaRepoPath: env.EXTENSION_QA_REPO_PATH ?? "",
    worktreeBasePath: env.WORKTREE_BASE_PATH ?? "",
    planFilesPath: env.PLAN_FILES_PATH ?? "",
    logFilesPath: env.LOG_FILES_PATH ?? "",
    claudeMaxTurns: parseInt(env.CLAUDE_MAX_TURNS ?? "200", 10),
    claudeMaxBudgetUsd: parseFloat(env.CLAUDE_MAX_BUDGET_USD ?? "5.00"),
    claudeModel: prefs.claudeModel ?? env.CLAUDE_MODEL ?? "claude-sonnet-4-6",
    gitAuthorName: env.GIT_AUTHOR_NAME ?? "AutoZerts",
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL ?? "autozerts@noreply.github.com",
  };

  return cachedConfig;
}

export function clearConfigCache(): void {
  cachedConfig = null;
}
