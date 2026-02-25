import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { getConfig } from "../utils/preferences";
import type { RepoConfig } from "../types/preferences";


const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Return the canonical HTTPS URL for a repo using GITHUB_OWNER from .env.
 */
function getRepoUrl(repoName: string): string {
  const { githubOwner } = getConfig();
  return `https://github.com/${githubOwner}/${repoName}.git`;
}

/**
 * Run a git command authenticated with the PAT from .env.
 * The token is passed via an Authorization header so it never appears in URLs.
 */
async function gitAuth(args: string[], cwd: string): Promise<string> {
  const { githubToken } = getConfig();
  const basicAuth = Buffer.from(`pat:${githubToken}`).toString("base64");
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c", `http.https://github.com/.extraheader=Authorization: Basic ${basicAuth}`,
      ...args,
    ],
    { cwd, maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout.trim();
}

/**
 * Fetch from the canonical remote (GITHUB_OWNER) with PAT auth.
 * Updates origin/* remote-tracking refs.
 */
async function fetchOrigin(repoName: string, cwd: string): Promise<void> {
  const url = getRepoUrl(repoName);
  await gitAuth(
    ["fetch", url, "+refs/heads/*:refs/remotes/origin/*"],
    cwd,
  );
}

/**
 * Compute the worktree path for a given repo and branch.
 */
export function getWorktreePath(repoName: string, branchName: string): string {
  const { worktreeBasePath } = getConfig();
  return path.join(worktreeBasePath, repoName, branchName);
}

/**
 * Return the path for a plan file stored in the configured plan files directory.
 */
export function getPlanFilePath(branchName: string): string {
  const { planFilesPath } = getConfig();
  return path.join(planFilesPath, `${branchName}-plan.md`);
}

/**
 * Read an existing plan file. Returns null if it doesn't exist.
 */
export async function readPlanFile(branchName: string): Promise<string | null> {
  try {
    return await fs.readFile(getPlanFilePath(branchName), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Ensure the plan files directory exists.
 */
export async function ensurePlanFilesDir(): Promise<void> {
  const { planFilesPath } = getConfig();
  await fs.mkdir(planFilesPath, { recursive: true });
}

/**
 * Check if a worktree already exists at the given path.
 */
export async function worktreeExists(worktreePath: string): Promise<boolean> {
  try {
    await fs.access(worktreePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a git worktree for a task.
 *
 * Steps:
 * 1. git fetch (via GITHUB_OWNER URL + PAT auth header) in the main repo
 * 2. git worktree add -b <branch> <worktreePath> origin/<baseBranch>
 *    If branch exists remotely, checkout existing instead of -b
 *
 * Note: Fetch and push use the GITHUB_OWNER URL (not the repo's origin remote)
 * with PAT auth via Authorization header. Git identity is injected via
 * GIT_AUTHOR_* / GIT_COMMITTER_* env vars in the Claude process.
 */
export async function createWorktree(params: {
  repo: RepoConfig;
  branchName: string;
  baseBranch: string;
}): Promise<string> {
  const { repo, branchName, baseBranch } = params;
  const worktreePath = getWorktreePath(repo.name, branchName);

  // If the worktree already exists on disk, reuse it
  if (await worktreeExists(worktreePath)) {
    await fetchOrigin(repo.name, repo.localPath);
    return worktreePath;
  }

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  // Fetch latest from the canonical remote
  await fetchOrigin(repo.name, repo.localPath);

  // Check if the branch already exists on the remote
  let branchExistsRemotely = false;
  try {
    await git(
      ["rev-parse", "--verify", `origin/${branchName}`],
      repo.localPath,
    );
    branchExistsRemotely = true;
  } catch {
    // Branch does not exist remotely
  }

  if (branchExistsRemotely) {
    await git(
      [
        "worktree",
        "add",
        "--track",
        "-b",
        branchName,
        worktreePath,
        `origin/${branchName}`,
      ],
      repo.localPath,
    );
  } else {
    await git(
      [
        "worktree",
        "add",
        "-b",
        branchName,
        worktreePath,
        `origin/${baseBranch}`,
      ],
      repo.localPath,
    );
  }

  return worktreePath;
}

/**
 * Remove a git worktree.
 */
export async function removeWorktree(
  repo: RepoConfig,
  worktreePath: string,
): Promise<void> {
  try {
    await git(["worktree", "remove", "--force", worktreePath], repo.localPath);
  } catch {
    // If git worktree remove fails, try to clean up manually
    await fs.rm(worktreePath, { recursive: true, force: true });
    await git(["worktree", "prune"], repo.localPath);
  }
}

/**
 * Detect the package manager used in a project and install dependencies.
 */
export async function installDependencies(worktreePath: string): Promise<void> {
  const lockFiles: Record<string, { cmd: string; args: string[] }> = {
    "bun.lockb": { cmd: "bun", args: ["install"] },
    "bun.lock": { cmd: "bun", args: ["install"] },
    "pnpm-lock.yaml": { cmd: "pnpm", args: ["install", "--frozen-lockfile"] },
    "yarn.lock": { cmd: "yarn", args: ["install", "--frozen-lockfile"] },
    "package-lock.json": { cmd: "npm", args: ["ci"] },
  };

  for (const [lockFile, { cmd, args }] of Object.entries(lockFiles)) {
    try {
      await fs.access(path.join(worktreePath, lockFile));
      await execFileAsync(cmd, args, {
        cwd: worktreePath,
        maxBuffer: 50 * 1024 * 1024,
      });
      return;
    } catch {
      // Lock file doesn't exist or install failed, try next
    }
  }

  // Fallback: if package.json exists, try npm install
  try {
    await fs.access(path.join(worktreePath, "package.json"));
    await execFileAsync("npm", ["install"], {
      cwd: worktreePath,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    // No package.json — nothing to install
  }
}

/**
 * Stage and commit any uncommitted changes in the worktree.
 * Returns true if a commit was created, false if the tree was clean.
 */
export async function commitAllChanges(worktreePath: string): Promise<boolean> {
  // Run prettier on changed files before committing
  try {
    const { stdout: diffOutput } = await execFileAsync(
      "git",
      ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"],
      { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 },
    );
    const changedFiles = diffOutput
      .trim()
      .split("\n")
      .filter(f => f.length > 0);
    if (changedFiles.length > 0) {
      await execFileAsync("npx", ["prettier", "--write", ...changedFiles], {
        cwd: worktreePath,
        maxBuffer: 10 * 1024 * 1024,
      });
    }
  } catch {
    // prettier not available or failed — continue without formatting
  }

  await git(["add", "-A"], worktreePath);

  // git diff --cached --quiet exits with 1 when there are staged changes
  try {
    await git(["diff", "--cached", "--quiet"], worktreePath);
    return false; // working tree is clean
  } catch {
    // there are staged changes — commit them
  }

  const config = getConfig();
  await execFileAsync("git", ["commit", "-m", "Apply remaining changes"], {
    cwd: worktreePath,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: config.gitAuthorName,
      GIT_AUTHOR_EMAIL: config.gitAuthorEmail,
      GIT_COMMITTER_NAME: config.gitAuthorName,
      GIT_COMMITTER_EMAIL: config.gitAuthorEmail,
    },
  });
  return true;
}

/**
 * Push the branch to the canonical remote (GITHUB_OWNER) with PAT auth.
 */
export async function pushBranch(
  worktreePath: string,
  branchName: string,
  repoName: string,
): Promise<void> {
  const url = getRepoUrl(repoName);
  await gitAuth(["push", url, `HEAD:refs/heads/${branchName}`], worktreePath);
}

/**
 * Pull latest changes from origin for the current branch with rebase.
 * Rebases local commits on top of remote changes.
 */
export async function pullBranch(
  worktreePath: string,
  branchName: string,
  repoName: string,
): Promise<void> {
  const url = getRepoUrl(repoName);
  await gitAuth(["pull", "--rebase", url, branchName], worktreePath);
}
