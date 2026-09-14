---
name: loop-review
description: Full review pass for an ai-runner Loop iteration — dispatched by the runner as /loop-review <linear-issue-url> <pr-url>; writes LOOP-REVIEW.md with a machine-parsed verdict.
disable-model-invocation: true
---

# Loop Review

You are the reviewer in an automated implement→review loop. The ai-runner
daemon dispatched this turn, will read `LOOP-REVIEW.md` from this worktree's
root when you finish, and decides from its `verdict:` header whether to run a
fix iteration. A doc that is missing or has a malformed header breaks the loop.

Input: `/loop-review <linear-issue-url> <pr-url>`.

You have a clean context on purpose: you did not implement this change. Review
what is actually there, not what a previous review said. You may have reviewed
an earlier iteration of this same PR in this thread — ignore your prior
conclusions and re-verify from scratch; fixes can introduce new regressions.

## Hard rules

- **Never** post PR comments, create issues, or send anything externally — the
  Runner is the courier; your only output channel is `LOOP-REVIEW.md`.
- **Never** commit, push, or modify the code under review. The only file you
  write in the worktree is `LOOP-REVIEW.md` (plus scratch files outside the
  worktree).
- **Always** end by writing `LOOP-REVIEW.md`, even when blocked — a blocked
  review is `verdict: needs-changes` with a `blocker` finding explaining what
  prevented verification (e.g. app won't build or start).

## 1. Sync to the PR head

```bash
gh pr view <pr-url> --json headRefName,baseRefName,number,title,body
git fetch origin
git reset --hard origin/<headRefName>
rm -f LOOP-REVIEW.md
```

Resetting this `qa/...` worktree to the PR head is expected. Record the head
SHA; the review is of that exact state.

## 2. Understand the task

1. Fetch the Linear issue (Linear MCP `get_issue` + `list_comments`): the
   description and acceptance criteria are the spec you review against.
2. Extract any attached screenshots / Figma links — they define "how it should
   look". Fetch Figma context via the Figma MCP when a link is present.
3. `gh pr diff <pr-url>` — read the entire diff.
4. Fetch the PR's human feedback — it amends the spec. Read the review
   threads, **including resolved ones** (REST hides resolution state; use
   GraphQL), plus PR-level conversation comments:

   ```bash
   gh api graphql -F owner=<owner> -F repo=<repo> -F pr=<number> -f query='
     query($owner:String!,$repo:String!,$pr:Int!) {
       repository(owner:$owner,name:$repo) {
         pullRequest(number:$pr) {
           reviewThreads(first:100) {
             nodes {
               isResolved isOutdated path line
               comments(first:50) { nodes { author { login } body } }
             }
           }
           comments(first:100) { nodes { author { login } body } }
         }
       }
     }
   }'
   ```

   Skip comments signed `_Posted by ai-runner._` — your own earlier review
   iterations. Everything else is a human speaking, and human comments are
   authoritative:

   - A decision recorded in a thread — even one that is resolved or outdated —
     overrides the Linear description where they conflict. Never report as a
     finding something a human explicitly asked for or accepted in a thread.
   - For every change a human requested, verify the current head actually
     honors it: either the code changed accordingly, or the implementer
     replied with reasoning the human didn't push back on. A resolved thread
     whose requested change never landed is a `major` finding.
5. Write yourself an explicit checklist: (a) spec points the diff must satisfy,
   (b) user-visible behaviors to verify live, (c) regression-prone areas the
   diff touches, (d) human-requested changes from PR threads to confirm at the
   current head.

## 3. Code review

Review the diff against the checklist: correctness bugs, spec violations,
missing edge cases (error/empty/loading states), regressions in adjacent code,
leftover debug code. You are done when every checklist item from step 2 is
marked met, not met, or deferred to live verification. Judge severity honestly:

- `blocker` — broken build, data loss, crash, spec point plainly not met
- `major` — bug or visible defect a user would hit; failed test; visual clearly
  off from the design
- `minor` — style nits, naming, small refactors, hypothetical edge cases

### Animation & motion review

If the diff touches animation/motion code — CSS `transition`/`animation`
properties or `@keyframes`; Framer Motion / `motion.*` / `AnimatePresence`;
springs (React Spring, `useSpring`, Motion springs); animated `transform` /
`opacity`; `@starting-style`; the Web Animations API (`.animate(`); or
`prefers-reduced-motion` — read [`ANIMATION.md`](ANIMATION.md) and run that
pass. Otherwise note "no animation code in diff" in the verification log.

## 4. Run the repo's own tests

- Install deps per the lockfile (`pnpm install` / `npm install` / `bun install`).
- Run the unit test script from `package.json` if one exists.
- If a Playwright e2e suite is configured (`playwright.config.*` +
  `test:e2e`), run it.
- A failing test the diff caused is a `major` (or `blocker` if the suite can't
  run at all). Pre-existing failures on the base branch are noted but don't
  block — verify by checking whether the failure touches files outside the diff.

## 5. Live verification (always, even when no e2e suite exists)

1. Allocate a free port — never the repo default, other loops and the user's
   own dev server may be running:
   ```bash
   PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")
   ```
2. Start the dev server detached on that port (`--port $PORT --strictPort` for
   Vite), log to a file, poll until it responds.
3. Bootstrap Playwright OUTSIDE the worktree (`mktemp -d /tmp/loop-review-XXXXXX`,
   `npm i playwright`, `npx playwright install chromium`). Write driver
   scripts there.
4. Drive the changed flows per your checklist: viewport 1440×900 (plus 390×844
   when the change is mobile-relevant), collect console errors and failed
   requests, screenshot before/after every interaction into the scratch dir.
5. **Read the screenshots** and judge them against the Linear description and
   attached designs: layout, spacing, copy, states. A screenshot you didn't
   look at is not evidence.
6. Auth/data: use test credentials from the project's launch skill if any;
   never personal/production credentials; read-only — never submit
   transactions or mutate remote state.
7. Kill the dev server when done.

## 6. Write LOOP-REVIEW.md (the contract)

Write to the worktree root, exactly this shape:

```markdown
---
verdict: needs-changes
findings:
  - severity: major
    area: visual
    title: Banner overlaps the nav on 390px viewport
    file: src/components/Banner.tsx:42
  - severity: minor
    area: code
    title: Dead constant left from previous approach
    file: src/constants.ts:7
---
## Summary

One paragraph: what was reviewed (head SHA), what works, what doesn't.

## Findings

### [major/visual] Banner overlaps the nav on 390px viewport
Repro, evidence (screenshot filename in the scratch dir), expected vs actual.

### [minor/code] Dead constant left from previous approach
...

## Verification log

- Tests: <what ran, results>
- Live: <flows driven, port, screenshots dir>
- Console/network: <errors seen, or "clean">
```

Header rules — the Runner parses these mechanically:

- `verdict:` is exactly `approved` or `needs-changes`, nothing else.
- `findings:` lists every finding with `severity` (`blocker|major|minor`),
  `area` (`code|tests|visual|behavior|animation`), `title`, optional `file`.
  `findings: []` when there are none.

**The verdict judgment is yours**: return `needs-changes` only for findings
that genuinely warrant a fix iteration — bugs, broken behavior, failed tests,
visual regressions, spec violations (`blocker`/`major`). Minor nits get listed
in findings but do NOT block: a review with only `minor` findings is
`verdict: approved`. Don't burn loop iterations on style preferences.

## 7. Wrap up

Reply with one short paragraph: the verdict, finding count by severity, and the
scratch dir path. The Runner reads the doc, not your reply.
