/** Minimal Linear GraphQL client (API-key auth). */
import { config, type RepoConfig } from "./config";

const LINEAR_API = "https://api.linear.app/graphql";

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: config.linearApiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(`Linear API: ${json.errors.map((e) => e.message).join("; ")}`);
  if (!json.data) throw new Error("Linear API: empty response");
  return json.data;
}

export interface LinearAttachment {
  id: string;
  url: string;
  title: string;
  subtitle: string | null;
  sourceType: string | null;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  branchName: string;
  priority: number;
  priorityLabel: string;
  updatedAt: string;
  state: { name: string; type: string };
  labels: { nodes: Array<{ name: string; color: string }> };
  attachments: { nodes: LinearAttachment[] };
}

const ISSUE_FIELDS = `
  id identifier title description url branchName priority priorityLabel updatedAt
  state { name type }
  labels { nodes { name color } }
  attachments { nodes { id url title subtitle sourceType } }
`;

export async function getIssue(idOrIdentifier: string): Promise<LinearIssue> {
  const data = await gql<{ issue: LinearIssue }>(
    `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
    { id: idOrIdentifier },
  );
  return data.issue;
}

export interface MyIssuesResult {
  issues: LinearIssue[];
}

/** Issues assigned to the API key's user, active cycle + recent, all states. */
export async function listMyIssues(): Promise<LinearIssue[]> {
  const data = await gql<{ viewer: { assignedIssues: { nodes: LinearIssue[] } } }>(
    `query MyIssues {
       viewer {
         assignedIssues(
           first: 100
           orderBy: updatedAt
           filter: { state: { type: { nin: ["completed", "cancelled"] } } }
         ) { nodes { ${ISSUE_FIELDS} } }
       }
     }`,
  );
  return data.viewer.assignedIssues.nodes;
}

export async function createAttachment(params: {
  issueId: string;
  url: string;
  title: string;
  subtitle?: string;
}): Promise<void> {
  await gql(
    `mutation CreateAttachment($input: AttachmentCreateInput!) {
       attachmentCreate(input: $input) { success }
     }`,
    { input: params },
  );
}

/** Parse a Linear issue URL or bare identifier into the identifier (e.g. WLT-123). */
export function parseIssueRef(ref: string): string {
  const urlMatch = ref.match(/linear\.app\/[^/]+\/issue\/([A-Za-z]+-\d+)/);
  if (urlMatch) return urlMatch[1];
  const bare = ref.match(/^[A-Za-z]+-\d+$/);
  if (bare) return ref.toUpperCase();
  throw new Error(`Not a Linear issue reference: ${ref}`);
}

export function findT3ThreadAttachment(issue: LinearIssue): { threadId: string } | null {
  for (const a of issue.attachments.nodes) {
    const m = a.url.match(/^http:\/\/127\.0\.0\.1:\d+\/threads\/([0-9a-f-]+)/);
    if (m) return { threadId: m[1] };
  }
  return null;
}

export function findPrAttachment(issue: LinearIssue): { url: string; number: number } | null {
  for (const a of issue.attachments.nodes) {
    const m = a.url.match(/github\.com\/.+\/pull\/(\d+)/);
    if (m) return { url: a.url, number: parseInt(m[1], 10) };
  }
  return null;
}

/**
 * If the title opens with one of the repo's issue prefixes (`Web:` or `[Web]`,
 * case-insensitive), return the exact leading substring to strip — delimiter and
 * trailing whitespace included — so callers can show the icon in its place.
 * Longest prefix wins (`Web App` before `Web`). Returns null when nothing matches.
 */
export function titlePrefixForRepo(title: string, repo: RepoConfig | undefined): string | null {
  if (!repo) return null;
  const lower = title.toLowerCase();
  const prefixes = [...(repo.issuePrefixes ?? [])].sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    const pl = prefix.toLowerCase();
    for (const opener of [`${pl}:`, `[${pl}]`]) {
      if (lower.startsWith(opener)) {
        let end = opener.length;
        while (end < title.length && /\s/.test(title[end])) end++;
        return title.slice(0, end);
      }
    }
  }
  return null;
}

/** The configured repo whose issuePrefixes match the title, or undefined (no fallback). */
export function findRepoByTitlePrefix(title: string): RepoConfig | undefined {
  return config.repos.find((repo) => titlePrefixForRepo(title, repo) !== null);
}

/**
 * The configured repo whose `labels` (falling back to `issuePrefixes`) match one
 * of the issue's labels, case-insensitively, or undefined. Lets a task tagged
 * `extension`/`dashboard`/`web` carry the right project even without a prefix.
 */
export function findRepoByLabels(labels: string[]): RepoConfig | undefined {
  const issueLabels = new Set(labels.map((l) => l.toLowerCase()));
  return config.repos.find((repo) =>
    (repo.labels ?? repo.issuePrefixes ?? []).some((key) => issueLabels.has(key.toLowerCase())),
  );
}

/** The repo an issue belongs to, by title prefix first then by label. Undefined when neither matches. */
export function findRepoForIssue(title: string, labels: string[] = []): RepoConfig | undefined {
  return findRepoByTitlePrefix(title) ?? findRepoByLabels(labels);
}

/** Like {@link findRepoForIssue} but falls back to the first configured repo. */
export function findDefaultRepo(title: string, labels: string[] = []): RepoConfig | undefined {
  return findRepoForIssue(title, labels) ?? config.repos[0];
}
