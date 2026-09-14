/**
 * Git operations on a repo's QA Companion Repo — the separate local clone a
 * human checks a Loop's Task Branch out into to run a real QA build. The engine
 * never touches it; only the Loop Detail QA-build control drives these. Mirrors
 * the Raycast "switch qa branch" command's `git.ts`, but runs server-side
 * through the same hardened subprocess runner the `gh` calls use.
 */
import fs from "node:fs";
import { run } from "./github";

export interface QaRepoStatus {
  /** Branch currently checked out in the QA repo, or null if detached/unknown. */
  currentBranch: string | null;
  /** The Loop's Task Branch — the branch we want checked out there. */
  taskBranch: string;
  /** Whether the QA repo is already on the Task Branch. */
  onBranch: boolean;
  /** Commits on `origin/<taskBranch>` not yet in the QA repo's local copy. */
  unpulled: number;
  /** Set when the QA repo is unusable (bad path, not a git repo, fetch failed). */
  error?: string;
}

/** The checked-out branch, or null on detached HEAD / not-a-repo. */
async function currentBranch(cwd: string): Promise<string | null> {
  const res = await run(cwd, ["git", "branch", "--show-current"]);
  if (!res.ok) return null;
  return res.stdout.length ? res.stdout : null;
}

/**
 * Commits on `origin/<taskBranch>` not yet in the local copy. Uses `HEAD` when
 * the QA repo is already on the branch, the local ref otherwise. Returns 0 when
 * the local ref is missing (the branch was never checked out here) — matching
 * the Raycast behavior; the first checkout creates the tracking branch.
 */
async function unpulledCount(cwd: string, taskBranch: string, onBranch: boolean): Promise<number> {
  const range = onBranch ? `HEAD..origin/${taskBranch}` : `${taskBranch}..origin/${taskBranch}`;
  const res = await run(cwd, ["git", "rev-list", range, "--count"]);
  if (!res.ok) return 0;
  const n = parseInt(res.stdout, 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Fetch the Task Branch and report where the QA repo stands relative to it. A
 * missing path / not-a-git-dir surfaces as `error` (rather than throwing) so the
 * control renders a broken-repo state instead of vanishing. Pass `fetch: false`
 * to skip the network round-trip when origin was just updated by a checkout.
 */
export async function qaRepoStatus(
  cwd: string,
  taskBranch: string,
  { fetch = true }: { fetch?: boolean } = {},
): Promise<QaRepoStatus> {
  // A missing directory would make the subprocess spawn throw, not fail — guard
  // it so a misconfigured path renders the broken state instead of a 500.
  if (!fs.existsSync(cwd)) {
    return { currentBranch: null, taskBranch, onBranch: false, unpulled: 0, error: `QA repo path not found: ${cwd}` };
  }
  const fetched = fetch ? await run(cwd, ["git", "fetch", "origin", taskBranch]) : null;
  const branch = await currentBranch(cwd);
  // No branch readable AND the fetch failed ⇒ the path isn't a usable repo.
  if (branch === null && fetched && !fetched.ok) {
    return { currentBranch: null, taskBranch, onBranch: false, unpulled: 0, error: fetched.stderr || "QA repo unavailable" };
  }
  const onBranch = branch === taskBranch;
  const unpulled = await unpulledCount(cwd, taskBranch, onBranch);
  return { currentBranch: branch, taskBranch, onBranch, unpulled };
}

/** Checkout-or-pull: switch the QA repo to the Task Branch, or pull it if already there. */
export async function qaRepoCheckout(cwd: string, taskBranch: string): Promise<QaRepoStatus> {
  if (!fs.existsSync(cwd)) {
    return { currentBranch: null, taskBranch, onBranch: false, unpulled: 0, error: `QA repo path not found: ${cwd}` };
  }
  const err = await doCheckout(cwd, taskBranch);
  // Re-read without a second fetch — doCheckout already updated origin.
  const status = await qaRepoStatus(cwd, taskBranch, { fetch: false });
  return err ? { ...status, error: err } : status;
}

/** Run the fetch → (checkout) → pull sequence; returns a stderr message on failure. */
async function doCheckout(cwd: string, taskBranch: string): Promise<string | null> {
  const fetched = await run(cwd, ["git", "fetch", "origin", taskBranch]);
  if (!fetched.ok) return fetched.stderr || "git fetch failed";
  const branch = await currentBranch(cwd);
  if (branch !== taskBranch) {
    const co = await run(cwd, ["git", "checkout", taskBranch]);
    if (!co.ok) return co.stderr || "git checkout failed";
  }
  // --ff-only: the QA repo is never hand-edited, so a non-fast-forward means
  // something is wrong — fail loudly rather than create a merge commit.
  const pulled = await run(cwd, ["git", "pull", "--ff-only"]);
  if (!pulled.ok) return pulled.stderr || "git pull failed";
  return null;
}
