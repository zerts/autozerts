---
name: linear-implement
description: Implement a Linear issue end-to-end — hydrate a worktree, grill for scope, post a PRD comment back to Linear, implement, open a PR. Use when the user provides a Linear issue URL or identifier (e.g. linear.app/.../issue/TEAM-123) and asks to implement, build, or work on it.
---

# Linear Implement

## Quick start

User provides a Linear URL like `https://linear.app/zerion/issue/WEB-1234/fix-login-bug`. Run the workflow below: fetch → **hydrate** the worktree (branch + env files) → judge (default to grilling) → grill the gaps → write the PRD comment back to Linear → implement → PR → summary. Hydrate up front, before grilling, so the environment is ready to build the moment scope is clear. Clarifying scope before coding is the norm, not the exception — only genuinely atomic or fully-specified issues skip the grill. Every decision reached in the grill is consolidated into a single PRD and posted to the Linear task before any code is written, so the reasoning lives in Linear and not in throwaway files.

## Workflow

### 1. Fetch the issue

Parse the identifier (`WEB-1234`) from the URL. Then:

- `mcp__claude_ai_Linear__get_issue` with that identifier — read title, description, labels, priority, the `branchName` field
- `mcp__claude_ai_Linear__list_comments` — comments often contain the PRD or clarifications

### 2. Hydrate the worktree

**Branch name**: take the `branchName` field from the Linear issue verbatim. Truncate to 64 characters max (cut at the last `-` boundary before 64 if possible, otherwise hard cut).

**Worktree location**: a sibling folder of the repo root, in a `<repo-name>-wt` container, named after the branch.

Example: if the repo lives at `/path/to/web-app`, the worktree goes at `/path/to/web-app-wt/<branch-name>`.

Branch from `main` (fall back to `master` if `main` doesn't exist). Use the `EnterWorktree` tool if available, otherwise:

```bash
git fetch origin main
git worktree add ../<repo-name>-wt/<branch-name> -b <branch-name> origin/main
```

If a worktree for this branch already exists (`git worktree list` shows it), enter it instead of recreating. Capture the worktree path — downstream steps need it. Then copy env files (step 3) regardless — an existing worktree still starts without them.

**Move the Linear issue to "In Progress" the moment the worktree exists** — not after some implementation is done, not after the grill, not at PR time. Work has started as soon as there's a branch, so the ticket should reflect that immediately. Use `mcp__claude_ai_Linear__save_issue` with the issue id from step 1, setting its state to the team's "In Progress" workflow state (look it up with `mcp__claude_ai_Linear__list_issue_statuses` for the issue's team if you don't already know the id). If the issue is already in "In Progress" or a later state, leave it as-is — never move it backwards.

### 3. Copy local env files

Untracked/ignored env files don't follow a `git worktree add`, so the new worktree starts without them. Copy **every** `.env*` file — not just the one at the repo root. Monorepos keep env files in nested package/app dirs (`apps/*/.env`, `packages/*/.env.local`), and missing one of those is the usual reason a build or dev server fails in the worktree.

Run this from the original repo root. It finds every `.env*` file (root and nested), skips `node_modules`/`.git`, and copies each into the worktree at the same relative path, creating parent dirs as needed:

```bash
SRC="<original-repo-root>"
DST="<worktree-path>"
copied=0
while IFS= read -r f; do
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f" && echo "copied: $f" && copied=$((copied+1))
done < <(cd "$SRC" && find . -type f -name '.env*' -not -path '*/node_modules/*' -not -path '*/.git/*' | sed 's|^\./||')
echo "env files copied: $copied"
```

Do **not** silence errors with `2>/dev/null || true` — if a copy fails, you need to see it. After running, **verify**: the printed count should be > 0 for any project that uses env files, and the files should now exist in the worktree (`find <worktree-path> -name '.env*' -not -path '*/node_modules/*'`).

If the count is 0, confirm the project genuinely has no env files (some don't) before moving on — don't assume. If it's a monorepo and you only copied the root file, you've likely missed nested ones; re-check the find output.

### 4. Judge readiness — default to grilling

Do not jump to implementation. First run an explicit **ambiguity pass**: read the issue adversarially and ask where a reasonable engineer could build the *wrong* thing and still believe they followed the ticket. For each item below, decide whether the issue answers it *unambiguously* — vague or implied answers count as gaps:

- **Outcome** — is the exact end state defined? What does "done" look like concretely?
- **Scope boundaries** — what's explicitly in and out? Which files/components/flows are touched, and which must NOT be?
- **Acceptance criteria** — testable conditions, or just a vibe?
- **Edge cases & states** — errors, empty/loading states, permissions, concurrency, backwards-compat?
- **Ambiguous terms** — any word that could mean two things ("fix", "support X", "like the other one", a feature name)?
- **UX/behavior details** — copy, placement, ordering, defaults, the unhappy path?
- **Technical approach** — one obvious correct implementation, or several with real trade-offs?

Then bucket:

- **Skip the grill — ONLY if one of these holds:**
  - **Atomic** — a one-step mechanical change with a single obvious correct outcome (typo, single-line bug, rename, dependency bump), and the ambiguity pass surfaced *nothing*; or
  - **Fully specified** — *every* item above is answered unambiguously by the description or comments. A long description is not enough on its own — it has to actually close the gaps.
- **Grill — everything else.** If the ambiguity pass surfaced even one easy-to-misinterpret item on a non-trivial task, you grill.

The bar is deliberately high, and the default is to grill. The cost of a few clarifying questions is minutes; the cost of confidently implementing the wrong thing is the whole task plus rework. **When in doubt, grill.** Do not rationalize ambiguity away to start coding sooner.

### 5. If not fully clear, grill the gaps

This is not all-or-nothing. Grill the *specific gaps* the ambiguity pass found — not the whole ticket. Invoke `/grill-with-docs` with the issue title, description, comments, **and the explicit list of ambiguous items you identified**, so the grill targets what's actually unclear instead of re-deriving the entire spec.

**Bring the grilling urge — at about half the intensity of a full `/grill-with-docs` session.** A standalone grill interviews relentlessly across the *entire* design tree; here you channel that same energy but aim it only at the gaps you found, so it stays proportionate to an implementation task. Within those gaps, though, push hard:

- **One question at a time.** Ask, wait for the answer, then ask the next. Don't dump a checklist.
- **Recommend an answer with every question.** Give your best default and the reasoning, so the user can confirm or correct rather than start from scratch.
- **Walk each branch.** When an answer opens a new decision, follow it before moving on — resolve dependencies between decisions in order.
- **Sharpen fuzzy language.** If the user (or the ticket) uses a vague or overloaded term, propose a precise canonical one and confirm it. Cross-check against the codebase and `CONTEXT.md` when one exists.
- **Stress-test with concrete scenarios.** Invent specific cases that probe edge states and force the user to be precise about boundaries — the unhappy path, empty/error states, concurrency, backwards-compat.
- **Don't accept vague answers.** If a reply leaves the point still ambiguous, re-ask on that exact point until there's exactly one interpretation left. Resist the pull to start coding sooner.

Stop grilling when the scope is unambiguous and every easy-to-misinterpret part has exactly one agreed-on interpretation — not before. Do not begin implementing while any *material* ambiguity remains.

### 6. Consolidate the grill into a PRD comment on Linear

When the grill ends — before writing any code — gather **everything** decided into one simple PRD and post it as a comment on the Linear task with `mcp__claude_ai_Linear__save_comment` (using the issue id from step 1). All decisions and ideas must live in Linear, never only in a temp file or in this conversation: the ticket has to carry its own context for the next person (or the next run).

Keep it simple and skimmable. Capture the *thinking*, not just the conclusion — the alternatives considered and why they were dropped are the part that gets lost otherwise. Use this structure:

```markdown
## PRD — <issue title>

### Problem / goal
<1–3 sentences: what we're solving and the desired end state>

### Decisions
- **<topic>:** <what we decided> — <why; what was rejected and the trade-off>
- ...

### Scope
- **In:** <what this change touches>
- **Out:** <what it explicitly does not>

### Open questions
- <anything still unresolved, or "none">

_Captured from a grilling session before implementation._
```

Only sections with real content need to appear. If the issue skipped the grill (atomic / fully specified in step 4), skip this step — there's nothing new to capture. After posting, keep the PRD in mind as the spec you implement against.

### 7. Implement

**Gate:** before reading or editing any file in the worktree, confirm step 3 ran (`find <worktree-path> -name '.env*' -not -path '*/node_modules/*'` lists the files). Reading code counts as touching the worktree — do step 3 first.

Inside the worktree, implement the task following normal engineering workflow — read relevant files, make changes.

### 8. Run pre-commit checks

Run the project's full local check suite from the project root, in this order. Stop and fix on the first failure before moving on.

1. **Install dependencies** — match the project's package manager (`pnpm install`, `npm install`, `yarn install`, etc.). Detect from the lockfile.
2. **Type-check** — usually `pnpm typecheck` / `npm run typecheck`; fall back to `tsc --noEmit` if no script.
3. **Lint** — usually `pnpm lint` / `npm run lint`.
4. **Prettier** — usually `pnpm format` / `pnpm prettier --write .`. Apply formatting, don't just check.

If a project uses different script names, inspect `package.json` scripts and use the closest equivalents.

### 9. Commit and open a PR

Once checks pass:

1. Stage and commit with a message starting with the Linear identifier, e.g. `WEB-1234: fix login redirect on expired session`.
2. Push the branch to `origin` with `-u`.
3. Create a PR with `gh pr create`. Title mirrors the commit subject. Body includes:
   - A short summary of the change
   - `Closes <TEAM-NUM>` so Linear's GitHub integration links and closes the issue on merge
   - A short test plan

Capture the PR URL from `gh pr create` output — the summary needs it.

The issue was already moved to "In Progress" back in step 2. Don't transition it further here — Linear's GitHub integration handles the move to review/done on PR open/merge.

### 10. Report a summary

End with a concise, well-formatted summary for the user:

```markdown
## WEB-1234 — <issue title>

**PR:** <pr-url>
**Linear:** <linear-issue-url>
**Branch:** `<branch-name>`
**Worktree:** `<worktree-path>`

### What changed
- <one bullet per meaningful change>

### Checks
- install ✓ · typecheck ✓ · lint ✓ · prettier ✓
```

Use real clickable links. If the grill flow ran, note that the decisions were consolidated into a PRD and posted as a comment on the Linear task.

## Notes

- This skill is Linear-specific. If the URL isn't a Linear issue, stop and ask the user for a Linear link.
- If `get_issue` returns nothing or auth fails, ask the user to authenticate via `mcp__claude_ai_Linear__authenticate` rather than guessing at the content.
- Never force-push, never push to `main`/`master`.
