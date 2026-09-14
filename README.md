# AI Runner

Pick a Linear task. Get back a reviewed GitHub pull request.

AI Runner is a local daemon that drives [T3 Code](https://t3.chat/code) through
implement→QA→review **Loops**: it opens a Claude Code thread on the task's
branch, waits for a PR, smoke-tests it in a real browser, reviews it, and sends
the review back as a fix turn until the PR is approved (max 5 iterations). A
web dashboard shows every loop, iteration, screenshot and review doc.

[![AI Runner dashboard (video)](https://brief.cleanshot.cloud/media/53980/BTLvqvsQHctv3aej6sy65poSejQc9MfRLc0AibPa.mp4.jpg?width=1200&height=630&scaling=fit&anchor=center&play=1&signature=e960761a4861f1d70aa4ec412311ef03cfd9f12cc4085415c811c8d0ba8a1541)](https://cleanshot.com/share/lnpbxBRh)

It also exposes an HTTP API for external triggers, so a launcher such as a
Raycast command can start loops too (that extension is not part of this repo).

Docs: [`CONTEXT.md`](./CONTEXT.md) (domain glossary) ·
[`docs/prd/ai-runner.md`](./docs/prd/ai-runner.md) (full spec) ·
[`docs/adr/`](./docs/adr/) (decisions)

## Requirements

- macOS (the background service uses launchd; other platforms can run
  `bun run start` by hand)
- [Bun](https://bun.sh)
- [T3 Code](https://t3.chat/code), installed and signed in. The runner talks to
  T3 through its local, undocumented interfaces (a signing key under
  `~/.t3/userdata` and the orchestration websocket). It is an unofficial
  integration and may break on T3 updates.
- [Claude Code](https://claude.com/claude-code) with the **Linear MCP** server
  connected (the skills read and comment on issues through it)
- GitHub CLI `gh`, authenticated
- A Linear workspace and a personal API key
- Node/npm on the PATH (skills bootstrap Playwright with it on first QA run)

Linear is the only task tracker supported today.

## Setup

The fastest path is to let Claude Code walk you through it. Clone, install,
link the skills, then run the setup skill from the repo root in Claude Code or
T3 Code:

```bash
git clone https://github.com/zerts/autozerts.git && cd autozerts
bun install && bun run install-skills
```

```
/runner-setup
```

It runs `bun run doctor`, fixes what it can, asks only for what it cannot
detect (your repos, how each one is served and authenticated for QA), tells
you which file to paste each key into (never the chat), and ends with the
dashboard open. It is safe to re-run.

Manual equivalent:

```bash
cp .env.example .env    # fill LINEAR_API_KEY and REPOS
bun run doctor          # checklist of everything below; exit 1 while anything fails
bun run build:web
bun run start           # http://127.0.0.1:4777
```

Background service (starts at login, restarts on crash):

```bash
bun run install-agent              # install + start
bun run install-agent --uninstall  # remove
```

## Repository layout

Two sibling checkouts, under the same parent directory:

```
<parent>/autozerts/           this repo (public): runner, dashboard, skills
<parent>/autozerts-private/   yours (private): qa-profiles/<repo>.md, internal docs
```

Skills resolve the private repo as `../autozerts-private`. It holds the
per-repo **QA profile** `/loop-qa` follows to serve, authenticate and drive
each project; a repo with `qaGate` on and no profile fails the gate. Create it
from the template (`/runner-setup` does this for you):

```bash
cp -R templates/private-repo ../autozerts-private
# then fill ../autozerts-private/qa-profiles/<repo>.md from _example.md
```

Secret *values* (test-account credentials, Playwright storageState fixtures)
never go in either repo; they live under `DATA_DIR/qa/` and profiles point at
them.

Moving to a new machine: clone both repos side by side, copy `.env` and the
data dir, then `bun install`, `bun run install-skills`, `bun run build:web`,
`bun run install-agent`, and `bun run doctor`.

The data dir is self-contained and relocatable (all DB-stored paths are relative
to it). Layout — see `server/src/data-paths.ts` and ADR-0004:

```
config.json / runtime.json      editable config; { pid, port } for external launchers
db/runner.sqlite, db/backups/   state DB + snapshots
loops/<ISSUE>/<loopId>/<n>/     one dir per loop iteration: review.md, qa.md, screenshots/
qa/                             QA infrastructure only (fixtures, personas, secrets) — never per-loop output
logs/ai-runner.log              daemon log (override with LOG_FILE)
```

Upgrading from the pre-2026-09 layout (`reviews/`, `qa/<ISSUE>/`, root-level
sqlite): stop the daemon, run `bun run migrate-data`, then `bun run install-agent`.

## How a Loop runs

1. **Select** a task (web UI `/tasks`, or `POST /api/tasks/:ref/select`).
2. The Runner bootstraps a T3 thread on the issue's `branchName` and posts
   `/linear-implement <issue-url>`.
3. **PR Gate** — the loop advances when an open PR exists for the branch.
   Grilling just makes the loop `blocked` until you answer in T3 Code.
4. A single **Review Thread** (own `qa/` branch) runs `/loop-review`: code
   review + repo tests + live Playwright verification → `LOOP-REVIEW.md`.
5. The Runner couriers the doc: archives it, posts it as a PR comment, and —
   on `needs-changes` — compacts the impl thread and dispatches a fix turn.
6. **Push Gate** — the fix must advance `origin/<branch>`; then review again.
7. Ends `approved` or `exhausted` (max 5 iterations). Human PR comments later?
   Selecting the task again starts an **Address-Review Round**.

## Development

```bash
bun run dev                  # server with watch
bun run --cwd web dev        # Vite dev server (proxies /api to :4777)
cd server && bun test        # unit tests
cd server && bunx tsc --noEmit
```

Smoke tests against a live T3 Code (cheap, self-cleaning):

```bash
bun run server/scripts/smoke-a.ts   # dispatch + settle + worktree adoption
bun run server/scripts/smoke-b.ts <threadId>  # /compact turn semantics
```
