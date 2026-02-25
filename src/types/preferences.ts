/** Preferences and configuration types */

export interface RepoConfig {
  name: string;
  localPath: string;
  defaultBranch: string;
  issuePrefixes: string[];
}

export interface EnvConfig {
  linearApiKey: string;
  githubToken: string;
  githubOwner: string;
  repos: RepoConfig[];
  extensionQaRepoPath: string;
  worktreeBasePath: string;
  planFilesPath: string;
  logFilesPath: string;
  claudeMaxTurns: number;
  claudeMaxBudgetUsd: number;
  claudeModel: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
}

export interface RaycastPreferences {
  claudeModel?: string;
}

export interface AppConfig extends EnvConfig {
  // Raycast preferences override .env values when present
}
