# AutoZerts — Raycast Extension

Linear + Claude Code workflow automation: browse tasks, gather context, launch Claude to implement fixes in isolated git worktrees, and create PRs.

## Commands

| Command | Description |
|---|---|
| **Implement Task** | Browse Linear tasks and launch Claude Code to implement them in an isolated worktree |
| **Work in Progress** | Track open PRs, review status, and send feedback to Claude |
| **Prepare QA Note** | Generate QA release notes from Linear tasks grouped by release label |
| **Prepare Release Note** | Generate production release announcements with AI-powered changelog |
| **Open Resources** | Browse worktree folders and plan files, open in VS Code |
| **Run Orchestration** | Background worker for Claude Code orchestration |

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create your local config

`src/config.ts` is excluded from git because it contains machine- and org-specific values. Copy the example and fill in your own:

```bash
cp src/config.example.ts src/config.ts
```

Open `src/config.ts` and update:

- **`NODE_BIN_PATH`** — path to the directory containing your `node` binary. Run `dirname $(which node)` to find it.
- **`FALLBACK_ENV_PATH`** — absolute path to the `.env` file in your local checkout (used as a dev-mode fallback when Raycast's asset path resolution doesn't work).
- **`GITHUB_OWNER`** — your GitHub organisation login or personal username.
- **`REPOS`** — names of the repositories the extension has special knowledge about (see comments in the file for what each one enables).

### 3. Create your .env file

`.env` is also excluded from git. Create it at the project root:

```bash
cp .env.example .env   # if an example exists, otherwise create from scratch
```

Required variables:

| Variable | Description |
|---|---|
| `LINEAR_API_KEY` | Linear personal API key (Settings → API → Personal API keys) |
| `GITHUB_TOKEN` | GitHub personal access token with `repo` scope |
| `GITHUB_OWNER` | GitHub org or username (same as in `config.ts`) |
| `REPOS` | JSON array of repo configs: `[{"name":"...","localPath":"...","defaultBranch":"main","issuePrefixes":["EXT"]}]` |
| `EXTENSION_QA_REPO_PATH` | Absolute path to your local QA companion repo checkout |
| `WORKTREE_BASE_PATH` | Directory where Claude's isolated git worktrees are created |
| `PLAN_FILES_PATH` | Directory where task plan files are stored |
| `GIT_AUTHOR_NAME` | Name used for commits made by Claude |
| `GIT_AUTHOR_EMAIL` | Email used for commits made by Claude |

Optional:

| Variable | Description |
|---|---|
| `CLAUDE_MAX_TURNS` | Max agentic turns per Claude run (default: `200`) |
| `CLAUDE_MAX_BUDGET_USD` | Max spend per Claude run in USD (default: `5.00`) |
| `CLAUDE_MODEL` | Model ID override (can also be set in Raycast preferences) |

### 4. Run in development

```bash
npm run dev
```

### 5. Build

```bash
npm run build
```
