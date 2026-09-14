# PRD: AI Runner

**Status:** Implemented (2026-06-10). Deviations: the Raycast extension keeps `t3code.ts` for the QA-session form and the app-focus helper (the open-in-t3-code path is fully routed through the Runner); end-to-end live-loop validation on a real task is pending.
**Author:** Andrey
**Date:** 2026-06-10
**Companion docs:** [`CONTEXT.md`](../../CONTEXT.md) (glossary — terms in **bold** below are defined there), [`docs/adr/0001`](../adr/0001-runner-couriers-review-docs.md), [`docs/adr/0002`](../adr/0002-one-reused-review-thread-per-loop.md)

## 1. Overview

AI Runner is a local background server that owns all communication with T3 Code. It supervises multi-iteration implement→review **Loops** on Linear tasks: dispatch an implementation thread, wait for a PR, review it with a dedicated review thread (code review + repo tests + live Playwright verification), feed findings back as fix turns, and repeat until the review approves or 5 iterations are exhausted. Data source: a Linear task. Outcome: a GitHub pull request.

It exposes an HTTP API (consumed by the Raycast extension, which becomes a thin client) and serves a minimal shadcn/ui web dashboard with stats and controls.

## 2. Goals

- One click (Raycast or web UI) from a Linear task to a fully supervised implement→review→fix Loop.
- The Runner is the **single owner** of T3 Code dispatch — no more duplicated protocol code.
- Reviews verify *behavior and looks*, not just code: live Playwright drive judged against the Linear task description and attachments.
- Loops survive Runner restarts and T3 Code downtime without losing state or double-dispatching.
- Human stays in the loop where it matters: grilling flows through unchanged (**Blocked** state), review history lands as PR comments, exhausted Loops are flagged, never auto-merged.

## 3. Non-goals

- No replacement of the headless `implement-task` Raycast flow (it coexists, untouched).
- No auto-merge of PRs; no writes to the QA repo.
- No multi-repo Loops (one repo per Loop), no remote access (localhost only).
- No token/cost accounting (T3's sqlite doesn't expose it cleanly).
- No changes to T3 Code itself — we use its existing WS RPC, sqlite projections, and worktree bootstrap.

## 4. System architecture

```
┌─────────────┐   HTTP (127.0.0.1:4777)   ┌──────────────────────────────┐
│   Raycast   │──────────────────────────▶│           AI Runner          │
│ (thin client)│                          │  Bun + Hono + bun:sqlite     │
└─────────────┘                           │                              │
┌─────────────┐   HTTP + SSE              │  • Loop engine (state machine)│
│  Web UI     │──────────────────────────▶│  • T3 client (WS RPC dispatch│
│ React+shadcn│                           │    + sqlite polling)         │
└─────────────┘                           │  • Linear client (REST/GQL)  │
                                          │  • GitHub via `gh` CLI       │
                                          │  • Review Doc courier        │
                                          └──────┬───────────┬───────────┘
                                                 │ WS RPC    │ readonly sqlite
                                                 ▼           ▼
                                          ┌──────────────────────────────┐
                                          │   T3 Code (~/.t3/userdata)   │
                                          │  threads / turns / worktrees │
                                          └──────────────────────────────┘
```

- **Repo layout:** Bun workspaces — `server/` (Hono API + loop engine, TS run directly by Bun) and `web/` (Vite + React + Tailwind + shadcn/ui, built into static assets served by the server).
- **Process model:** launchd agent (`~/Library/LaunchAgents/com.autozerts.ai-runner.plist`, `KeepAlive`), installed via `bun run install-agent`. `bun run dev` for foreground development.
- **Data dir:** `~/.ai-runner/data/` — `runner.sqlite`, `runtime.json` (`{ port }`, for Raycast port discovery), `reviews/<TASK-ID>/<iteration>.md` archive.
- **Logs:** `~/.ai-runner/logs/ai-runner.log`.

### 4.1 T3 Code integration (ported from `raycast-extension/src/services/t3code.ts`)

- Read `~/.t3/userdata/server-runtime.json` for port/origin; HMAC-sign short-lived `kind:"websocket"` tickets from `secrets/server-signing-key.bin` + active `auth_sessions` row.
- Dispatch via WS RPC `orchestration.dispatchCommand` (`thread.turn.start`, with `bootstrap.createThread` + `bootstrap.prepareWorktree` for new threads).
- **Change from the extension:** all sqlite reads go through `bun:sqlite` in readonly mode (parameterized queries) instead of `execFile("/usr/bin/sqlite3")`.
- **Polling:** every 3s for threads owned by active Loops: `projection_turns.state` (`pending|running|completed|error`), `projection_threads.worktree_path`, `pending_approval_count`, `pending_user_input_count`.
- Model selection: `CLAUDE_MODEL` env mapped through the ported `claudeModelSelection()` (claudeAgent instance, effort xhigh, 200k).

### 4.2 Linear client

API key auth (`LINEAR_API_KEY`). Needs: list my issues (same query/sections as the extension's `fetchMyIssuesAllStates`, including attachments), get issue (title, description, `branchName`, attachments, comments), `attachmentCreate`.

### 4.3 GitHub

Via the already-authenticated `gh` CLI: `gh pr list --head <branch> --json ...`, `gh pr comment`, `gh pr view`. No token in config.

## 5. The Loop state machine

States: `queued → running (implementing | reviewing | fixing | compacting) → approved | exhausted | cancelled | error`, with `blocked` and `paused` interrupting `running`. (See **Loop States** in CONTEXT.md.)

### 5.1 Start (via **Select**)

1. `POST /api/tasks/:issueId/select` with body `{ repo, extras?, autonomous?, forceGrill?, interactive? }`.
2. Decision tree (the only copy, in the Runner):
   - **Active Loop exists** → return it (`209`-style no-op; caller focuses it). Never dispatches.
   - **Terminal Loop (`approved`/`exhausted`) + open PR** → return `address-review-available` with the PR's unresolved review threads (GraphQL via `gh`); the caller shows them in a confirm dialog and starts the **Address-Review Round** (§5.5) via `POST /api/tasks/:issueId/address-review`. Never auto-starts.
   - **No Loop** → create Loop in `queued`; if a recorded **Interactive Open** thread exists for the task, adopt it as the Implementation Thread instead of creating one.
3. Slot check: ≤10 running Loops (configurable) → `running (implementing)`, else FIFO queue.

### 5.2 Implementing phase

1. Fetch the issue from Linear → **Task Branch** = `branchName` verbatim, truncated to 64 chars at the last `-` boundary (same rule as `linear-implement`).
2. Dispatch new Implementation Thread: bootstrap `prepareWorktree { projectCwd: repo.localPath, baseBranch: repo.defaultBranch, branch: <task-branch> }`, `runSetupScript: true`. First message:
   - default: `/linear-implement <issue-url>` (+ `\n\n<extras>` if any)
   - `forceGrill`: `/grill-with-docs <issue-url>` (+ extras)
   - `autonomous`: append "Don't grill — make reasonable assumptions and record them in the PR description."
3. Create Linear attachments: `T3 Code thread` deep link (existing convention) + `AI Runner loop` → `http://127.0.0.1:4777/loops/<id>`.
4. Poll. On every completed turn, evaluate the **PR Gate**: open PR for the Task Branch (`gh pr list --head`, Linear PR-attachment fallback)?
   - **Yes** → record PR number/URL, go to §5.3.
   - **No** → `blocked` (amber; macOS notification; "open in T3 Code" link). The human converses in T3 directly; the Runner keeps polling — any later completed turn re-evaluates the gate. Blocked Loops release their concurrency slot.
   - Turn `error` → Loop `error` (red; **Retry last phase** re-dispatches).
   - `pending_approval_count > 0` or `pending_user_input_count > 0` mid-turn → show as `blocked` without leaving the phase.

### 5.3 Reviewing phase

1. **First iteration only:** create the Review Thread — bootstrap `prepareWorktree { baseBranch: <task-branch>, branch: qa/<task-branch>-<base36-ts> }` (**Review Branch**, `generateQaBranchName` convention), `runSetupScript: true`. First message: `/loop-review <issue-url> <pr-url>`.
2. **Subsequent iterations:** post a **Compact Turn** (`/compact`) on the Review Thread, wait for completion, then post: `/loop-review <issue-url> <pr-url>` (the skill itself hard-resets to `origin/<task-branch>` and re-reviews with fresh eyes).
3. On review turn completion: read the **Review Doc** from `<review-worktree>/LOOP-REVIEW.md` (worktree path from `projection_threads.worktree_path`).
4. Courier (ADR-0001): archive to `autozerts-data/reviews/<TASK-ID>/<n>.md`; post as PR comment (`gh pr comment`, prefixed `## 🔄 Loop review — iteration <n>/5`); parse the **Verdict**.
   - `approved` → Loop `approved` (green; notification; done — PR awaits human review/merge).
   - `needs-changes` → §5.4.
   - Missing/unparseable doc → treat as `needs-changes` whose "review doc" is an instruction to re-run the review properly; this consumes the fix turn as a re-review request, not an iteration increment, max once per iteration before `error`.

### 5.4 Fixing phase

1. Iteration counter check: if this was iteration 5 → `exhausted`; post final PR comment "Review loop exhausted after 5 iterations — needs human attention"; notification; stop.
2. Post a **Compact Turn** on the Implementation Thread, wait.
3. Post the fix turn with the Review Doc injected:
   > Address every `needs-changes` finding below from the loop review. Commit and **push** to `<task-branch>` when done.
   > `<review doc content>`
4. On completion, **Push Gate**: compare `origin/<task-branch>` HEAD SHA before/after the fix turn (`git ls-remote`). If unchanged, post one follow-up turn ("you haven't pushed — commit and push"); if still unchanged → `blocked`. If advanced → increment iteration, back to §5.3.

### 5.5 Address-Review Round

Entry: **Select** on a terminal Loop with an open PR (human left review comments on GitHub) surfaces the unresolved threads; the human confirms via `POST /api/tasks/:issueId/address-review`.

1. Reset iteration budget (fresh max-5); state `running (fixing)`.
2. Post `/address-review` on the Implementation Thread (compact first).
3. After the turn: same Push Gate, then normal §5.3 reviewing — verify the addressed changes, iterate if `needs-changes`.

### 5.6 Cancel / Retry / One more round

- **Cancel:** dispatch `thread.turn-interrupt-requested` for any active turn, mark `cancelled`. Threads/worktrees remain in T3 (no destructive cleanup).
- **Retry last phase** (from `error`): re-dispatch the last intended turn (safe — dispatches are journaled, see §5.7).
- **Run one more round** (from `exhausted`): one extra fix+review iteration.

### 5.7 Crash recovery & T3 downtime

- Every intended dispatch is journaled in `runner.sqlite` **before** sending. On startup: reload active Loops, and for each "dispatched but unconfirmed" entry check T3's `projection_thread_messages` for the journaled `messageId` — present → confirm; absent → safe to re-send. Never blind re-dispatch.
- Re-derive phase from reality: latest turn states + PR Gate + Push Gate, then resume.
- T3 unreachable (no `server-runtime.json` / dispatch fails) → affected Loops `paused`; probe every 30s; auto-resume. Global red banner in UI.

## 6. The `/loop-review` skill (`skills/loop-review/`, linked into `~/.claude/skills/` by `bun run install-skills`)

Owns the Review Doc contract. Invoked as `/loop-review <linear-issue-url> <pr-url>` inside the Review Thread. Steps it must perform:

1. `git fetch && git reset --hard origin/<task-branch>` (task branch derived from the PR via `gh pr view`).
2. Fetch the Linear issue (MCP): description, acceptance criteria, attached screenshots / Figma links.
3. **Code review** of the PR diff against the task — correctness, spec compliance, regressions (borrow the `code-review` skill's approach).
4. **Repo test suite:** unit tests always; `test:e2e` (Playwright) where the repo has it.
5. **Live verification (always):** install deps if needed, start the dev server on a **self-allocated free port** (never the repo default — concurrent Loops and the user's own dev server must never collide), drive the affected flows with a Playwright browser, screenshot, judge "does it look/behave as the task says it should" against description + attachments (borrow `qa-playwright`'s approach, but **never** post to the PR — output goes only to the doc; the Runner is the courier).
6. Write `LOOP-REVIEW.md` at the worktree root:

```markdown
---
verdict: approved | needs-changes
iteration: <n>
findings:
  - severity: blocker | major | minor
    area: code | tests | visual | behavior
    title: <one line>
    file: <path:line, optional>
---
## Summary
<prose>
## Findings
<detail per finding, screenshots referenced by relative path>
```

Verdict judgment lives here: `needs-changes` **only** for findings that genuinely warrant a fix round (bugs, broken behavior, failed tests, visual regressions, spec violations). Minor nits → listed, but `verdict: approved`.

## 7. HTTP API

```
GET  /api/health                 → { status, version, t3: "up"|"down", port }
GET  /api/issues                 → proxied Linear list w/ loop-state badges (Task Picker)
POST /api/tasks/:issueId/select  → body { repo?, extras?, autonomous?, forceGrill? }
                                   → { action: "loop-started"|"focused"|"done"|"address-review-available", loop, unresolvedThreads? }
POST /api/tasks/:issueId/address-review → confirmed Address-Review Round start
                                   → { action: "address-review-started"|"focused"|"done", loop }
POST /api/threads                → Interactive Open (no Loop); body { issueId, repo, extras?, forceGrill? }
GET  /api/loops                  → all Loops + states (dashboard, Raycast accessories)
GET  /api/loops/:id              → detail: phase, iterations[{n, verdict, docPath, durations}], links
POST /api/loops/:id/cancel
POST /api/loops/:id/retry        → retry last phase (from error)
POST /api/loops/:id/one-more     → one extra iteration (from exhausted)
GET  /api/loops/:id/reviews/:n   → archived Review Doc (rendered in Loop Detail)
GET  /api/events                 → SSE: loop.updated, t3.availability, stats.updated
GET  /api/stats                  → dashboard stats (see §8)
```

`select` returns enough for the caller to act without local logic — UI and Raycast both just render `action`.

## 8. Web UI (Vite + React + Tailwind + shadcn/ui — minimal, clean)

1. **Dashboard `/`** — Loop cards grouped: `running` (phase shown), `blocked` (amber, T3 link), `queued`, recent terminals (`approved` green / `exhausted` red / `cancelled`). Stats bar: active / queued / blocked counts, completed-this-week, approval rate (approved without exhaustion), avg iterations per Loop, avg wall-clock per Loop. Global red banner when T3 is down.
2. **Task Picker `/tasks`** — Linear issues in the extension's sections (Todo / In Progress / Backlog / Done+Cancelled, AI-Ready floated), loop-state badge per row; click → **Select**; when the tree says "new Loop", a dialog with repo dropdown (default via the ported `findDefaultRepo` heuristic), extras textarea, autonomous + force-grill switches. When the tree says `address-review-available`, a dialog lists the PR's unresolved review threads with a "Start address-review round" confirm button.
3. **Loop Detail `/loops/:id`** — iteration timeline (per-turn durations, verdict chips), rendered Review Docs (tabs per iteration), links (PR, Linear, T3 thread), controls (Cancel / Retry last phase / Run one more round).

Liveness via the SSE stream; shadcn components (Card, Badge, Dialog, Tabs, Table); no client-side routing library beyond the basics.

**Notifications:** `osascript -e 'display notification ...'` on `blocked` and every terminal state.

## 9. Raycast extension changes (thin-client migration)

- New `src/services/runner.ts`: port discovery (`autozerts-data/runtime.json`), `/api/health` probe, `select`, `threads`, `loops` calls.
- `OpenInT3CodeList`: primary action → `select` (toast reflects returned `action`); secondary action "Open interactively (no Loop)" → `POST /api/threads`; accessory badges from `GET /api/loops`. Form gains autonomous + force-grill fields (form only shown when the runner reports a new Loop is needed).
- `src/services/t3code.ts` **deleted** after migration; Runner unreachable → toast "Start AI Runner first" with a copyable `launchctl` hint.
- Linear listing stays in the extension (it already has creds) — only dispatch/loop logic moves.

## 10. Config (`ai-runner/.env`)

```
PORT=4777
LINEAR_API_KEY=lin_api_...
REPOS=[{"name":"pulse-frontend","localPath":"/path/to/pulse-frontend","defaultBranch":"main"}, ...]
CLAUDE_MODEL=claude-fable-5
DATA_DIR=~/.ai-runner/data
LOG_FILE=~/.ai-runner/logs/ai-runner.log
MAX_PARALLEL_LOOPS=10
MAX_ITERATIONS=5
```

Same `REPOS` JSON shape as the extension — copy-paste compatible. `.env.example` committed; `.env` gitignored.

## 11. Runner persistence (`runner.sqlite`)

- `loops` — id, issue_id, issue_identifier, repo, state, phase, iteration, task_branch, pr_number, autonomous, created_at, updated_at, terminal_at
- `threads` — loop_id (nullable for Interactive Opens), role (`implementation|review`), t3_thread_id, branch, worktree_path, adopted
- `dispatches` — journal: loop_id, t3_thread_id, message_id, kind (`first|fix|compact|review|address-review|nudge-push`), payload, dispatched_at, confirmed_at
- `iterations` — loop_id, n, verdict, review_doc_path, started_at, reviewed_at, remote_sha_before, remote_sha_after
- `events` — append-only state transitions (drives stats + Loop Detail timeline)

## 12. Error handling

| Condition | Behavior |
| --- | --- |
| T3 Code not running / dispatch fails | Loop `paused`, probe 30s, auto-resume; UI banner |
| Turn ends `error` | Loop `error`; Retry re-dispatches via journal |
| Review Doc missing/unparseable | One re-review request turn; second miss → `error` |
| Fix turn doesn't push | One nudge turn; then `blocked` |
| PR closed/merged mid-Loop | Loop → terminal `cancelled` with reason "PR closed externally" |
| `gh` unauthenticated / Linear 401 | Loop `error` with actionable message; health endpoint reports it |
| Linear attachment create fails | Non-fatal: log, continue (Runner DB is the source of truth) |
| Duplicate select racing | One-Loop-per-task enforced by unique index on `loops(issue_id) WHERE state NOT IN (terminal)` |

## 13. Implementation plan

### Phase 0 — Scaffold
1. `git init`; Bun workspaces `server/` + `web/`; Hono hello-world serving built `web/` assets + `/api/health`; `.env.example`, config loader; CONTEXT.md/ADRs already in place.

### Phase 1 — T3 client + smoke tests *(de-risks everything)*
2. Port `t3code.ts` → `server/src/t3/` on `bun:sqlite` (runtime/signing/session reads, WS RPC dispatch, project lookup).
3. Turn poller (3s) + thread watcher abstraction (`await turnCompleted(threadId)`).
4. **Smoke test A:** dispatch a new thread bootstrap into a scratch repo, watch it complete.
5. **Smoke test B (flagged in grill):** dispatch `/compact` as a turn — verify turn-state lifecycle and that the session continues.
6. **Smoke test C (flagged in grill):** bootstrap with a Linear-style `branchName` and confirm `/linear-implement` enters the T3 worktree (no second worktree).

### Phase 2 — Persistence + Loop engine (implement phase only)
7. `runner.sqlite` schema + dispatch journal + crash-recovery reconciliation.
8. Linear client (list/get/attachmentCreate); `gh` wrapper (PR by head branch, comment, view).
9. Loop engine: queued→implementing→PR Gate→blocked/approved-stub; concurrency slots; Paused probing.
10. Minimal API: `select` (new-Loop path), `loops`, `cancel`; SSE skeleton.

### Phase 3 — Review machinery
11. Write the `/loop-review` skill (port-allocation discipline, doc contract, no-PR-posting rule).
12. Review Thread lifecycle (create once, compact + re-review turns); Review Doc courier (read → archive → PR comment → parse Verdict).
13. Fixing phase: compact + injected fix turn + Push Gate; iteration budget; `exhausted` flow.
14. **End-to-end dry run on a real small task** in `pulse-frontend` (the "validation task").

### Phase 4 — Full decision tree
15. `select` complete: focus / Address-Review Round / Interactive-Open adoption; `POST /api/threads`; retry / one-more endpoints.

### Phase 5 — Web UI
16. Vite + Tailwind + shadcn scaffold in `web/`; Dashboard with SSE-live cards + stats bar.
17. Task Picker (sections, badges, start-Loop dialog); Loop Detail (timeline, rendered docs, controls).

### Phase 6 — Raycast migration
18. `runner.ts` service + health probe; rewire `OpenInT3CodeList` to `select`/`threads`/`loops`; delete `t3code.ts`.

### Phase 7 — Ops polish
19. launchd plist + `install-agent` script + `runtime.json`; log rotation (append + size cap); macOS notifications.
20. Full validation pass (§14) on 2–3 real tasks, including one that grills (Blocked path) and one address-review re-entry.

### Phase ordering rationale
T3 protocol risk first (1), engine before UI (2–4), the two grill-flagged unknowns are smoke tests 5–6 before anything depends on them.

## 14. Validation plan

1. Smoke tests A–C pass (Phase 1).
2. Well-specified task → Loop runs unattended → PR + ≥1 review iteration → `approved`; review history visible as PR comments + Loop Detail.
3. Underspecified task → Loop `blocked` with notification → answer grill in T3 → Loop advances on PR appearance without any Runner interaction.
4. Force a `needs-changes` review (intentionally buggy implementation) → fix turn addresses findings → re-review approves; iteration counter and archive correct.
5. Kill the Runner mid-review → restart → Loop resumes correct phase, no duplicate turns (journal check).
6. Quit T3 Code mid-Loop → `paused` + banner → relaunch T3 → auto-resume.
7. Human PR comments after `approved` → Select → Address-Review Round → verification review runs.
8. 3 concurrent Loops on different ports/repos — no dev-server collisions; cap + queue respected.
9. Raycast: select/focus/interactive-open all work through the Runner; runner-down toast correct.

## 15. Open implementation questions (not blockers)

- Does a `/compact`-only turn produce a `projection_turns` row with a normal `completed` transition, or complete instantly with no turn row? (Smoke test B decides how the poller treats it.)
- `prepareWorktree` semantics when the branch already exists locally/remotely (Address-Review-Round-after-restart edge) — verify T3 reuses rather than fails.
- Whether T3's UI focuses a thread on `open -a` alone or needs the deep link (`http://127.0.0.1:<t3-port>/threads/<id>`) — affects the "open in T3 Code" buttons.
- Playwright browser availability inside review worktrees (`npx playwright install` cost) — the skill may need a shared-browsers env var (`PLAYWRIGHT_BROWSERS_PATH`) to avoid per-worktree downloads.
