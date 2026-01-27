/** GitHub REST API types */

export interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  url: string;
  head: GitHubRef;
  base: GitHubRef;
  user: GitHubUser;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  draft: boolean;
  additions: number;
  deletions: number;
  changed_files: number;
  mergeable_state?: string;
  review_comments?: number;
}

export interface GitHubRef {
  ref: string;
  sha: string;
  repo: {
    name: string;
    full_name: string;
    html_url: string;
  };
}

export interface GitHubUser {
  login: string;
  avatar_url: string;
  html_url: string;
}

export interface GitHubReview {
  id: number;
  user: GitHubUser;
  body: string | null;
  state:
    | "APPROVED"
    | "CHANGES_REQUESTED"
    | "COMMENTED"
    | "DISMISSED"
    | "PENDING";
  submitted_at: string;
  html_url: string;
}

export interface GitHubComment {
  id: number;
  user: GitHubUser;
  body: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  path?: string;
  line?: number;
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "action_required"
    | null;
  html_url: string;
}

export interface GitHubCheckSuiteResponse {
  total_count: number;
  check_runs: GitHubCheckRun[];
}

export interface GitHubSearchItem {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: string;
  pull_request?: {
    url: string;
    html_url: string;
  };
  repository_url: string;
}

export interface GitHubSearchResponse {
  total_count: number;
  items: GitHubSearchItem[];
}

export interface CreatePullRequestParams {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
}
