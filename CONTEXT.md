# AI Runner

A local background server that owns all communication with T3 Code: it starts and supervises multi-iteration implement→review Loops on Linear tasks, exposes an HTTP API for external triggers (Raycast, web UI), and serves a minimal shadcn/ui dashboard with stats and controls. Data source: a Linear task. Outcome: a GitHub pull request.

## Language

### Core

**Runner**:
The single long-lived local server process (this app); the only component that dispatches commands to T3 Code.
_Avoid_: daemon, orchestrator, server-app

**Loop**:
One supervised implement→review→fix cycle for one Linear task, ending in a clean review, exhaustion, or cancellation. One Loop per task is a hard invariant.
_Avoid_: pipeline, job, run (reserve "run" for a single thread turn)

**Iteration**:
One implement(or fix)→review round inside a Loop; a Loop runs at most 5.

**Thread**:
A T3 Code thread (their concept) — the Runner creates them, posts turns, and polls their state via T3's sqlite (`projection_turns.state`, every 3s).

**Implementation Thread**:
The Loop's primary Thread; works on the Task Branch, gets compacted between Iterations, and produces the PR.

**Review Thread**:
The Loop's single reviewer Thread, created once per Loop on its own Review Branch (git forbids two worktrees on one branch) and reused: each Iteration posts a turn that hard-resets to the PR head and re-reviews with fresh eyes.

### Review

**Loop Review Skill** (`/loop-review`):
A new global skill in `~/.claude/skills` owning the Review Doc contract: reset to PR head → code-review the diff vs the Linear task → run a dedicated motion-craft pass (`review-animations`) whenever the diff touches animation/motion code → run the repo's own test suite (incl. Playwright e2e where configured) → always drive the running app with a Playwright browser and judge the result against the Linear task description and attached screenshots/Figma → write the Review Doc with Verdict header. Allocates its own free dev-server port, never the repo default.

**Review Doc**:
The file the Review Thread writes at a fixed path in its own worktree; the Runner couriers it — archives a copy per Iteration in its data dir, injects it into the next fix turn, and posts it as a PR comment. Never committed to git (see ADR-0001).

**Verdict**:
The machine-readable header of the Review Doc: `approved` or `needs-changes`. The reviewer owns the judgment (minor nits don't block approval); the Runner only parses it. Missing/unparseable doc ⇒ treated as `needs-changes` with a re-run-review turn.

### Branches & gates

**Task Branch**:
Linear's `branchName` field verbatim (64-char truncation, same rule as `linear-implement`), used by the Runner for the Implementation Thread's `prepareWorktree` — so the skill enters the T3 worktree instead of creating a second one, and the PR head is known in advance.

**Review Branch**:
`qa/<task-branch>-<base36-ts>` (existing `generateQaBranchName` convention), created once per Loop for the Review Thread.

**PR Gate**:
The phase-transition rule: the implementation phase ends only when the latest turn is completed AND an open PR exists for the Task Branch (`gh pr list --head <branch>`, Linear PR-attachment as fallback). Turn count is irrelevant — grilled conversations advance whenever a PR finally appears.

**Compact Turn**:
A `/compact` posted as its own turn before every fix turn (Implementation Thread) and every re-review turn (Review Thread). Verified to pass through to the underlying Claude session. Failure is non-fatal: log and proceed uncompacted.

**QA Companion Repo**:
A second local clone of a repo (today only `zerion-wallet-extension` → `zerion-wallet-extension-qa`), separate from the Implementation Thread's worktree, that a human checks out a Loop's branch into to run a real QA build. Never written to by the Runner's engine; only the Loop Detail's QA-build control checks out / pulls the **Task Branch** there. Its filesystem path is the optional `qaCompanionPath` on the repo's config; a Loop shows the QA-build control iff its repo sets it. Mirrors the Raycast "switch qa branch" command, which owns the same path as its `extensionQaRepoPath` preference.
_Avoid_: QA repo (ambiguous with the QA *gate*), test repo

### Loop states

**Loop States**:
`queued → running (implementing | reviewing | fixing | compacting) → approved | exhausted | cancelled | error`, with `blocked` and `paused` as interruptions of `running`. Persisted in the Runner's sqlite; on restart the Runner re-derives the true phase from T3's turn log and `gh` before acting (dispatches are recorded before sending, so unconfirmed ones are verified, never blindly re-sent).

**Queued**:
Waiting for a concurrency slot (cap: 10 parallel Loops, configurable). FIFO start; Blocked Loops don't hold a slot.

**Blocked**:
A completed Implementation Thread turn leaves no open PR (e.g. the skill grilled) or approvals/input are pending — shown amber with an "open in T3 Code" link; the human converses in T3 directly, and the Loop advances on its own once the PR Gate passes.

**Paused**:
T3 Code is unreachable; the Runner probes every 30s and auto-resumes. Distinct from **Blocked** (waiting on the human) and **Queued** (waiting on a slot).

**Exhausted**:
Terminal state when Iteration 5 still ends `needs-changes` — PR stays open with a final "needs human attention" comment; shown red in the UI.
_Avoid_: failed (reserve for crashes/errors)

### Operations

**Select**:
The single decision-tree operation (`POST /api/tasks/:issueId/select`) shared by UI and Raycast: no Loop → start one; active Loop → focus it (never dispatches); terminal Loop + open PR → start an Address-Review Round. The tree lives only in the Runner.

**Address-Review Round**:
Re-entry into a terminal Loop: posts `/address-review` on the Implementation Thread, then runs normal Iterations (verify → fix → …) under a fresh max-5 budget.

**Interactive Open**:
A plain thread dispatch with no Loop (`POST /api/threads`) — today's behavior, kept as the secondary Raycast action. The Runner records these threads; a later Loop for the same task adopts the existing thread instead of duplicating it.

**Autonomous Flag**:
Per-Loop option that appends a "don't grill — make reasonable assumptions and record them in the PR description" instruction to the first message. Default: off. Its sibling **force-grill** makes the first message `/grill-with-docs <url>` instead; the Loop then sits Blocked until the grilled conversation produces a PR.

**Dashboard / Task Picker / Loop Detail**:
The three UI views. Dashboard: Loop cards by state + stats bar (active/queued/blocked, completed-this-week, approval rate, avg iterations, avg wall-clock). Task Picker: Linear issues with loop-state badges; clicking runs **Select**. Loop Detail: Iteration timeline, rendered Review Docs, PR/Linear/T3 links, controls (Cancel, Retry last phase, Run one more round). Live via SSE; macOS notifications on `blocked` and terminal states. Minimal, clean, shadcn/ui.

## Relationships

- The **Runner** owns all T3 Code dispatch; the Raycast extension is a thin HTTP client of the **Runner** (probes `/api/health`, discovers the port from the data dir's `runtime.json`).
- A **Loop** belongs to exactly one Linear task and drives exactly two **Threads**: one **Implementation Thread** and one **Review Thread**.
- A **Loop** runs 1–5 **Iterations**; each Iteration ends with a **Verdict**.
- The **Implementation Thread** works on the **Task Branch**; the **Review Thread** works on the **Review Branch** but always reviews `origin/<task-branch>`.
- The **Review Doc** flows Review Thread → Runner → (archive, PR comment, next fix turn). It never flows through git.
- A Linear issue carries two Runner-created attachments: the T3 thread deep link and the Loop URL (`http://127.0.0.1:4777/loops/<id>`).

## Example dialogue

> **Dev:** "The Loop for WLT-1509 has been sitting for an hour — is it broken?"
> **Domain expert:** "No, it's **Blocked**: `linear-implement` grilled and is waiting for answers in T3. Answer there; the **PR Gate** will advance the Loop the moment a turn completes with an open PR."
> **Dev:** "And when the reviewer finds only a naming nit?"
> **Domain expert:** "Then the **Verdict** is still `approved` — nits ride along in the PR comment but don't burn an **Iteration**. Only `needs-changes` triggers a Compact Turn + fix turn."
> **Dev:** "The PR got human review comments after the Loop approved. Do I start a new Loop?"
> **Domain expert:** "No — **Select** the task again; since the Loop is terminal with an open PR, that starts an **Address-Review Round** on the same threads."

## Flagged ambiguities

- "save result in the doc in the repo" — resolved: the Review Doc is written in the Review Thread's worktree but is **never committed**; durable copies live in the Runner archive and as PR comments (ADR-0001).
- "run another thread with the review skill … run the review again" — resolved: **one** Review Thread per Loop, reused across Iterations (ADR-0002), not a fresh thread per review.
- "until there is no comments" — resolved: not literal; the reviewer returns `approved` despite minor nits. The Runner never judges content, only parses the Verdict.
- Branch naming — resolved: raycast-style generated names are abandoned for Loops; the **Task Branch** is Linear's `branchName` verbatim, eliminating the double-worktree wart where `linear-implement` ignored the T3-bootstrapped worktree.
- "run playwright tests" — resolved: the repo's own e2e suite runs **where it exists** (only zerion-wallet-extension has one); live Playwright-driven visual verification runs **always**.
