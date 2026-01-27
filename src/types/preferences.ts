/** Preferences and configuration types */

export interface RepoConfig {
  name: string;
  localPath: string;
  defaultBranch: string;
}

export interface EnvConfig {
  jiraBaseUrl: string;
  jiraEmail: string;
  jiraApiToken: string;
  jiraProjectKeys: string[];
  githubToken: string;
  githubOwner: string;
  repos: RepoConfig[];
  worktreeBasePath: string;
  planFilesPath: string;
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
