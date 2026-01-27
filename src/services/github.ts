import { getConfig } from "../utils/preferences";
import type {
  GitHubPullRequest,
  GitHubReview,
  GitHubComment,
  GitHubCheckSuiteResponse,
  GitHubSearchResponse,
  GitHubSearchItem,
  CreatePullRequestParams,
} from "../types/github";

const API_BASE = "https://api.github.com";

async function ghFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { githubToken } = getConfig();
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status}: ${body}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Fetch open PRs authored by the current user, scoped to repos from .env config.
 */
export async function fetchMyOpenPRs(): Promise<GitHubPullRequest[]> {
  const { githubOwner, repos } = getConfig();
  if (repos.length === 0) return [];

  // Build a search query scoped to configured repos
  const repoFilters = repos.map((r) => `repo:${githubOwner}/${r.name}`).join(" ");
  const q = `author:@me type:pr state:open ${repoFilters}`;

  const data = await ghFetch<GitHubSearchResponse>(
    `/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=50`,
  );

  // Search API returns issue-shaped items without head/base.
  // Use repository_url + number to fetch the full PR object.
  const prs: GitHubPullRequest[] = [];
  await Promise.all(
    data.items.map(async (item: GitHubSearchItem) => {
      try {
        const repoPath = item.repository_url.replace(API_BASE, "");
        const pr = await ghFetch<GitHubPullRequest>(
          `${repoPath}/pulls/${item.number}`,
        );
        prs.push(pr);
      } catch {
        // Skip items we can't fetch full details for
      }
    }),
  );

  return prs;
}

/**
 * Fetch a single pull request.
 */
export async function fetchPullRequest(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GitHubPullRequest> {
  return ghFetch<GitHubPullRequest>(
    `/repos/${owner}/${repo}/pulls/${prNumber}`,
  );
}

/**
 * Fetch reviews for a pull request.
 */
export async function fetchReviews(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GitHubReview[]> {
  return ghFetch<GitHubReview[]>(
    `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
  );
}

/**
 * Fetch comments (issue comments) on a pull request.
 */
export async function fetchPRComments(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GitHubComment[]> {
  return ghFetch<GitHubComment[]>(
    `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
  );
}

/**
 * Fetch review comments (inline code comments) on a pull request.
 */
export async function fetchReviewComments(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GitHubComment[]> {
  return ghFetch<GitHubComment[]>(
    `/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
  );
}

/**
 * Fetch check runs for a ref.
 */
export async function fetchCheckRuns(
  owner: string,
  repo: string,
  ref: string,
): Promise<GitHubCheckSuiteResponse> {
  return ghFetch<GitHubCheckSuiteResponse>(
    `/repos/${owner}/${repo}/commits/${ref}/check-runs`,
  );
}

/**
 * Create a pull request.
 */
export async function createPullRequest(
  params: CreatePullRequestParams,
): Promise<GitHubPullRequest> {
  return ghFetch<GitHubPullRequest>(
    `/repos/${params.owner}/${params.repo}/pulls`,
    {
      method: "POST",
      body: JSON.stringify({
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base,
      }),
    },
  );
}

/**
 * Add a comment to a pull request.
 */
export async function addPRComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  await ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

/**
 * Parse owner/repo from a GitHub URL or full_name.
 */
export function parseRepoFullName(fullName: string): {
  owner: string;
  repo: string;
} {
  const parts = fullName.replace(/^https?:\/\/github\.com\//, "").split("/");
  return { owner: parts[0], repo: parts[1] };
}
