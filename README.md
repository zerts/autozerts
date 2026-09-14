# AI Runner

A local background server that owns all communication with T3 Code: it starts
and supervises implement→review **Loops** on Linear tasks, exposes an HTTP API
for external triggers (Raycast), and serves a web dashboard.

Data source: a Linear task. Outcome: a GitHub pull request, iterated until a
Playwright-backed review approves it (max 5 iterations).

Docs: [`CONTEXT.md`](./CONTEXT.md) (domain glossary) ·
[`docs/prd/ai-runner.md`](./docs/prd/ai-runner.md) (full spec) ·
[`docs/adr/`](./docs/adr/) (decisions)

## Repository layout

Two sibling checkouts are assumed, under the same parent directory:

```
<parent>/autozerts/           this repo (public): runner, dashboard, skills
<parent>/autozerts-private/   private repo: qa-profiles/<repo>.md, internal docs
```

Skills locate the private repo relative to this checkout (`../autozerts-private`),
so clone both side by side. `/loop-qa` refuses to run for a repo with no profile.

## Setup

```bash
cp .env.example .env   # fill LINEAR_API_KEY, REPOS (same shape as the Raycast extension)
bun install
bun run install-skills # symlink skills/* into ~/.claude/skills (runner dispatches them by name)
bun run build:web
bun run start          # http://127.0.0.1:4777
```

Background service (starts at login, restarts on crash):

```bash
bun run install-agent              # install + start
bun run install-agent --uninstall  # remove
```

Requirements: Bun, an authenticated `gh` CLI, T3 Code signed in, and the
skills from `skills/` installed (`bun run install-skills`): `/linear-implement`,
`/loop-qa`, `/loop-review`, `/address-review`, `/qa-playwright`.

New machine checklist: clone both repos side by side, copy `.env`, copy the
runtime data dir (default `~/.ai-runner/data`, or whatever `DATA_DIR` says)
including `qa/` secrets and fixtures, then `bun install`, `bun run install-skills`,
`bun run build:web`, `bun run install-agent`.

The data dir is self-contained and relocatable (all DB-stored paths are relative
to it). Layout — see `server/src/data-paths.ts` and ADR-0004:

```
config.json / runtime.json      editable config; { pid, port } for Raycast port discovery
db/runner.sqlite, db/backups/   state DB + snapshots
loops/<ISSUE>/<loopId>/<n>/     one dir per loop iteration: review.md, qa.md, screenshots/
qa/                             QA infrastructure only (fixtures, personas, secrets) — never per-loop output
logs/ai-runner.log              daemon log (override with LOG_FILE)
```

Upgrading from the pre-2026-09 layout (`reviews/`, `qa/<ISSUE>/`, root-level
sqlite): stop the daemon, run `bun run migrate-data`, then `bun run install-agent`.

## How a Loop runs

1. **Select** a task (web UI `/tasks`, Raycast, or `POST /api/tasks/:ref/select`).
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
