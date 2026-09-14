/** GitHub access via the authenticated `gh` CLI + git, scoped to a repo's local path. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A `gh`/`git` call must never hang indefinitely: a dropped network connection
// (or the box waking from sleep mid-request) can leave the subprocess wedged,
// which used to deadlock the engine tick. SIGKILL it past this bound and report
// a timeout so callers fail fast instead of awaiting forever.
const DEFAULT_RUN_TIMEOUT_MS = 30_000;

export async function run(
  cwd: string,
  cmd: string[],
  env?: Record<string, string>,
  opts: { timeoutMs?: number; stdin?: Uint8Array } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.stdin ? { stdin: opts.stdin } : {}),
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9); // SIGKILL — closes the pipes so the awaits below resolve
  }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (timedOut) {
      return { ok: false, stdout: "", stderr: `command timed out after ${timeoutMs}ms: ${cmd.join(" ")}` };
    }
    return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    clearTimeout(timer);
  }
}

export interface PrInfo {
  number: number;
  url: string;
  state: string;
  headRefName: string;
  baseRefName: string;
  title: string;
}

export async function openPrForBranch(repoPath: string, branch: string): Promise<PrInfo | null> {
  const res = await run(repoPath, [
    "gh", "pr", "list", "--head", branch, "--state", "open",
    "--json", "number,url,state,headRefName,baseRefName,title", "--limit", "1",
  ]);
  if (!res.ok) throw new Error(`gh pr list failed: ${res.stderr}`);
  const prs = JSON.parse(res.stdout || "[]") as PrInfo[];
  return prs[0] ?? null;
}

export async function prState(repoPath: string, number: number): Promise<"OPEN" | "CLOSED" | "MERGED"> {
  const res = await run(repoPath, ["gh", "pr", "view", String(number), "--json", "state"]);
  if (!res.ok) throw new Error(`gh pr view failed: ${res.stderr}`);
  return (JSON.parse(res.stdout) as { state: "OPEN" | "CLOSED" | "MERGED" }).state;
}

/** A PR's live status: its lifecycle plus the rolled-up CI check result. */
export interface PrStatus {
  /** `draft` is an open PR still marked draft; the rest map to the GitHub state. */
  state: "open" | "draft" | "merged" | "closed";
  /** CI rollup across every check, or null when the PR has no checks. */
  checks: "passing" | "failing" | "pending" | null;
}

interface RollupEntry {
  /** CheckRun lifecycle: QUEUED | IN_PROGRESS | COMPLETED. */
  status?: string;
  /** CheckRun outcome once COMPLETED. */
  conclusion?: string;
  /** Legacy StatusContext result: SUCCESS | FAILURE | PENDING | ERROR | EXPECTED. */
  state?: string;
}

const CHECK_FAILED = ["FAILURE", "TIMED_OUT", "CANCELLED", "ERROR", "ACTION_REQUIRED", "STARTUP_FAILURE"];
const CHECK_PENDING = ["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS"];

function rollupChecks(rollup: RollupEntry[] | null): PrStatus["checks"] {
  if (!rollup || rollup.length === 0) return null;
  let pending = false;
  for (const entry of rollup) {
    // A CheckRun that hasn't completed is still pending regardless of conclusion.
    if (entry.status && entry.status !== "COMPLETED") {
      pending = true;
      continue;
    }
    const result = entry.conclusion || entry.state || "";
    if (CHECK_FAILED.includes(result)) return "failing";
    if (CHECK_PENDING.includes(result)) pending = true;
  }
  return pending ? "pending" : "passing";
}

/** Lifecycle + CI rollup for a PR, in one `gh` call — drives the dashboard badges. */
export async function prStatus(repoPath: string, number: number): Promise<PrStatus> {
  const res = await run(repoPath, [
    "gh", "pr", "view", String(number), "--json", "state,isDraft,statusCheckRollup",
  ]);
  if (!res.ok) throw new Error(`gh pr view status failed: ${res.stderr}`);
  const pr = JSON.parse(res.stdout) as {
    state: "OPEN" | "CLOSED" | "MERGED";
    isDraft: boolean;
    statusCheckRollup: RollupEntry[] | null;
  };
  const state =
    pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open";
  return { state, checks: rollupChecks(pr.statusCheckRollup) };
}

export async function postPrComment(repoPath: string, number: number, body: string): Promise<void> {
  const res = await run(repoPath, ["gh", "pr", "comment", String(number), "--body-file", "-"], undefined, {
    stdin: new TextEncoder().encode(body),
  });
  if (!res.ok) throw new Error(`gh pr comment failed: ${res.stderr}`);
}

export interface ReviewThread {
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  /** When the thread was last resolved (ISO), or null if still open. Drives which
   *  round's human-review section the comment is shown under in the loop feed. */
  resolvedAt: string | null;
  comments: Array<{ author: string; body: string }>;
}

// GraphQL exposes no `resolvedAt` on a review thread (and the timeline enum has no
// thread-resolution event), so we approximate it with the thread's last comment
// time: an address-review round replies to a thread right before resolving it.
const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes {
            isResolved isOutdated path line
            comments(first: 50) { nodes { author { login } body createdAt } }
          }
        }
      }
    }
  }`;

interface ReviewThreadsResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: Array<{
            isResolved: boolean;
            isOutdated: boolean;
            path: string | null;
            line: number | null;
            comments?: { nodes?: Array<{ author: { login: string } | null; body: string; createdAt?: string }> };
          }>;
        };
      };
    };
  };
}

/** All review threads on a PR (resolved + unresolved). REST hides resolution state, so GraphQL. */
async function fetchReviewThreads(repoPath: string, prNumber: number): Promise<ReviewThread[]> {
  // owner/name come from the git remote (cached, no API cost) rather than
  // `gh repo view`, which spends a GraphQL query on data that never changes.
  const parsed = await githubOwnerRepo(repoPath);
  if (!parsed) throw new Error(`not a GitHub remote: ${repoPath}`);

  const res = await run(repoPath, [
    "gh", "api", "graphql",
    "-F", `owner=${parsed.owner}`, "-F", `repo=${parsed.repo}`, "-F", `pr=${prNumber}`,
    "-f", `query=${REVIEW_THREADS_QUERY}`,
  ]);
  if (!res.ok) throw new Error(`gh api graphql failed: ${res.stderr}`);
  const nodes = (JSON.parse(res.stdout) as ReviewThreadsResponse).data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];

  return nodes.map((n) => {
    const comments = n.comments?.nodes ?? [];
    // Proxy resolution time with the latest comment (the AI's resolving reply).
    const lastCreatedAt = comments.reduce<string | null>(
      (latest, c) => (c.createdAt && (!latest || c.createdAt > latest) ? c.createdAt : latest),
      null,
    );
    return {
      isResolved: n.isResolved,
      isOutdated: n.isOutdated,
      path: n.path ?? null,
      line: n.line ?? null,
      resolvedAt: n.isResolved ? lastCreatedAt : null,
      comments: comments.map((c) => ({ author: c.author?.login ?? "unknown", body: c.body })),
    };
  });
}

/** Unresolved review threads — drives the Address-Review Round offer. */
export async function unresolvedReviewThreads(repoPath: string, prNumber: number): Promise<ReviewThread[]> {
  return (await fetchReviewThreads(repoPath, prNumber)).filter((t) => !t.isResolved);
}

/** Every review thread on the PR — the human-review dialogue shown in the loop feed. */
export async function allReviewThreads(repoPath: string, prNumber: number): Promise<ReviewThread[]> {
  return fetchReviewThreads(repoPath, prNumber);
}

/** Extract the dev-build link from a PR's comments — the first comment opening
 *  with "deployed to domain", whose URL is returned. Null if none match. */
export function parseDevBuildUrl(comments: Array<{ body: string }>): string | null {
  for (const c of comments) {
    const body = (c.body ?? "").trim();
    if (!/^deployed to domain/i.test(body)) continue;
    const url = body.match(/https?:\/\/\S+/)?.[0];
    if (url) return url.replace(/[).,]+$/, ""); // trim trailing punctuation
  }
  return null;
}

/**
 * The dev-build link CI posts on the PR as a comment opening with
 * "deployed to domain <url>". Stable once it appears, so callers cache it and
 * stop asking. Returns null until CI has posted it.
 */
export async function fetchDevBuildUrl(repoPath: string, prNumber: number): Promise<string | null> {
  const res = await run(repoPath, ["gh", "pr", "view", String(prNumber), "--json", "comments"]);
  if (!res.ok) throw new Error(`gh pr view comments failed: ${res.stderr}`);
  const { comments } = JSON.parse(res.stdout || "{}") as { comments?: Array<{ body: string }> };
  return parseDevBuildUrl(comments ?? []);
}

/**
 * Fast-forward a repo's local base-branch ref to `origin/<branch>` before a new
 * worktree is cut from it, so Loops don't branch off a stale local `main`. Uses
 * `git fetch origin <branch>:<branch>`, which updates the ref directly without a
 * working tree — this succeeds precisely because the base branch is not checked
 * out anywhere (T3 works in worktrees; the primary tree sits on some other
 * branch). Best-effort: a non-fast-forward, a network blip, or the branch being
 * checked out just leaves the existing local ref in place. Returns whether the
 * ref was updated so callers can log the outcome.
 */
export async function refreshBaseBranch(repoPath: string, branch: string): Promise<{ ok: boolean; detail: string }> {
  const res = await run(repoPath, ["git", "fetch", "origin", `${branch}:${branch}`]);
  return { ok: res.ok, detail: res.ok ? "fast-forwarded" : res.stderr || "fetch failed" };
}

/** Remote head SHA for the Push Gate. Returns null when the branch doesn't exist on origin. */
export async function remoteHeadSha(repoPath: string, branch: string): Promise<string | null> {
  const res = await run(repoPath, ["git", "ls-remote", "origin", `refs/heads/${branch}`]);
  if (!res.ok) throw new Error(`git ls-remote failed: ${res.stderr}`);
  const sha = res.stdout.split(/\s+/)[0];
  return sha || null;
}

export interface UploadedImage {
  name: string;
  label?: string;
  /** A GitHub URL for the image, or null when hosting failed. */
  url: string | null;
}

/**
 * Host QA screenshots on a dedicated orphan `qa-artifacts` branch (never merged
 * into the PR) and return URLs to embed in the QA comment. Uses git plumbing
 * with a throwaway index so it never touches HEAD or the working tree:
 * hash-object each PNG → build a tree → commit-tree (parented on the existing
 * branch tip) → push. For a private repo the returned URLs don't render as
 * inline thumbnails (GitHub's camo proxy can't read private content), but the
 * link opens the image in GitHub's authenticated UI. See autozerts-private/docs/web-app-qa-gate.md §5.4.
 *
 * NOTE: the live push path is unverified against a real remote — smoke-test on a
 * throwaway PR before relying on it. Callers must treat this as best-effort.
 */
export async function uploadQaScreenshots(
  repoPath: string,
  keyPrefix: string,
  images: Array<{ path: string; label?: string }>,
): Promise<UploadedImage[]> {
  if (images.length === 0) return [];
  const branch = "qa-artifacts";

  // Parent commit = current remote tip of the artifacts branch, if any.
  let parent: string | null = null;
  const ref = await run(repoPath, ["git", "ls-remote", "origin", `refs/heads/${branch}`]);
  if (ref.ok && ref.stdout) {
    parent = ref.stdout.split(/\s+/)[0] || null;
    if (parent) await run(repoPath, ["git", "fetch", "origin", branch]);
  }

  const indexFile = path.join(os.tmpdir(), `qa-index-${process.pid}-${keyPrefix.replace(/[^A-Za-z0-9]/g, "-")}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await run(repoPath, parent ? ["git", "read-tree", parent] : ["git", "read-tree", "--empty"], env);

    const placed: Array<{ gitPath: string; name: string; label?: string }> = [];
    for (const img of images) {
      const hashed = await run(repoPath, ["git", "hash-object", "-w", img.path]);
      if (!hashed.ok) continue;
      const name = path.basename(img.path);
      const gitPath = `${keyPrefix}/${name}`;
      const added = await run(
        repoPath,
        ["git", "update-index", "--add", "--cacheinfo", `100644,${hashed.stdout.trim()},${gitPath}`],
        env,
      );
      if (added.ok) placed.push({ gitPath, name, ...(img.label ? { label: img.label } : {}) });
    }
    if (placed.length === 0) return [];

    const tree = await run(repoPath, ["git", "write-tree"], env);
    if (!tree.ok) throw new Error(`git write-tree failed: ${tree.stderr}`);
    const commitArgs = ["git", "commit-tree", tree.stdout.trim(), "-m", `qa artifacts ${keyPrefix}`];
    if (parent) commitArgs.push("-p", parent);
    const commit = await run(repoPath, commitArgs);
    if (!commit.ok) throw new Error(`git commit-tree failed: ${commit.stderr}`);

    await run(repoPath, ["git", "update-ref", `refs/heads/${branch}`, commit.stdout.trim()]);
    const push = await run(repoPath, ["git", "push", "origin", `${branch}:${branch}`]);
    if (!push.ok) throw new Error(`git push ${branch} failed: ${push.stderr}`);

    const webBase = await githubWebBase(repoPath);
    return placed.map((p) => ({
      name: p.name,
      ...(p.label ? { label: p.label } : {}),
      url: webBase ? `${webBase}/blob/${branch}/${p.gitPath}?raw=1` : null,
    }));
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

export async function ghAuthOk(): Promise<boolean> {
  const res = await run(process.cwd(), ["gh", "auth", "status"]);
  return res.ok;
}

/** Parse `{ owner, repo }` from an origin remote URL (ssh `git@github.com:owner/repo.git`
 *  or https form). Null if it's not a GitHub remote. */
export function parseGithubOwnerRepo(remote: string): { owner: string; repo: string } | null {
  const match = remote.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

/** Parse a repo's `https://github.com/owner/name` web base from its origin remote URL
 *  (ssh `git@github.com:owner/name.git` or https form). Null if it's not a GitHub remote. */
export function parseGithubWebBase(remote: string): string | null {
  const parsed = parseGithubOwnerRepo(remote);
  return parsed ? `https://github.com/${parsed.owner}/${parsed.repo}` : null;
}

const ownerRepoCache = new Map<string, { owner: string; repo: string } | null>();

/** The repo's `{ owner, repo }`, resolved from its `origin` remote and cached
 *  (the remote never changes at runtime). Null when not a GitHub remote. */
export async function githubOwnerRepo(repoPath: string): Promise<{ owner: string; repo: string } | null> {
  const cached = ownerRepoCache.get(repoPath);
  if (cached !== undefined) return cached;
  const res = await run(repoPath, ["git", "remote", "get-url", "origin"]);
  const parsed = res.ok ? parseGithubOwnerRepo(res.stdout) : null;
  ownerRepoCache.set(repoPath, parsed);
  return parsed;
}

/** The repo's GitHub web base, resolved from its `origin` remote and cached
 *  (the remote never changes at runtime). Null when not a GitHub remote. */
export async function githubWebBase(repoPath: string): Promise<string | null> {
  const parsed = await githubOwnerRepo(repoPath);
  return parsed ? `https://github.com/${parsed.owner}/${parsed.repo}` : null;
}
