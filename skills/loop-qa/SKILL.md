---
name: loop-qa
description: Implementation-side smoke gate for an ai-runner web-app Loop — serve the affected project locally from the just-pushed code, drive the affected flow with Playwright, screenshot it, and judge whether it BOOTS and RENDERS (not design quality — that's review). Project-specific serve/auth/seed live in the private sibling repo autozerts-private/qa-profiles/<repo>.md. Writes QA-RESULT.md with a machine-parsed verdict. Use when invoked as /loop-qa <linear-issue-url> <pr-url>. Output goes ONLY to QA-RESULT.md + screenshots — never post PR comments, never commit, push, or change code.
---

# Loop QA (smoke gate)

You are the QA smoke gate in an automated implement→QA→review loop, on the
**implementation thread** right after it pushed. The ai-runner daemon dispatched this
turn and reads `QA-RESULT.md` from the worktree root when you finish; its `qa:` header
decides whether the change proceeds to review or routes back to a fix iteration.

Input: `/loop-qa <linear-issue-url> <pr-url>`.

You answer one question: *does the change boot and render the affected flow without
breaking?* Design match, code quality, and spec completeness are `/loop-review`'s job —
you catch "it doesn't even run" so review never has to. When the change is visual you
always produce **a screenshot of the affected flow**. This file owns the contract (sync,
judge, QA-RESULT.md) and the generic Playwright driving; project-specific serve, auth,
seed, and gotchas live in the private profile `autozerts-private/qa-profiles/<repo>.md` (§2).

## Hard rules

- **Never** modify, commit, or push code. This turn verifies the pushed state as-is. The
  only things you write in the worktree are `QA-RESULT.md` and the `.qa-artifacts/`
  screenshot dir (both untracked; the Runner consumes and clears them).
- **Never** post PR comments or send anything externally — the Runner is the courier.
- **Never** submit transactions, write to a real account, or mutate remote state beyond
  what a read-only/test persona does. Use the test personas/accounts the profile names.
- **Always** end by writing `QA-RESULT.md`, even when blocked — a blocked gate is
  `qa: fail` with a `blocker` finding explaining what stopped verification (won't build,
  won't start, can't authenticate, affected screen throws).

## 1. Sync and understand what changed

```bash
gh pr view <pr-url> --json headRefName,number,title,body
git fetch origin
git reset --hard origin/<headRefName>   # this worktree IS the PR head; align to it exactly
rm -rf QA-RESULT.md .qa-artifacts
gh pr diff <pr-url>                      # read the diff
```

From the Linear issue (Linear MCP `get_issue`) and the diff, decide:

- **The affected flow** — which route(s) / screen(s) the change is visible on. This is
  what you'll drive and screenshot.
- **`visual_change`** — does the diff touch UI (routes, components, styles, copy, assets)?
  If yes, a screenshot of the affected flow is a *required* output.
- **How to make the new UI reachable** — many changes are hidden behind a feature flag, a
  mock/scenario toggle, or a particular account state. Grep the diff for the gate
  (`useGate` / `useExperiment` / a dev-menu flag / a tier check) and note what you must
  flip on. Your project profile (§2) says *how* to flip it (Statsig override, dev menu,
  persona). Screenshot the flow with the gate ON, or you'll verify the old UI.

## 2. Select the project profile

This worktree is one specific repo. Identify it, then read its profile — that profile is
authoritative for §3 (serve) and the auth/seed parts of §4:

```bash
basename -s .git "$(git remote get-url origin)"   # e.g. zerion-web-app, api-developer-dashboard
```

Profiles are private (test accounts, internal hosts) and live in the `autozerts-private`
repo, checked out as a sibling of the `autozerts` checkout this skill is symlinked from:

```bash
RUNNER="$(cd "$(dirname "$(readlink -f ~/.claude/skills/loop-qa)")/../.." && pwd)"
PRIVATE="$RUNNER/../autozerts-private"
cat "$PRIVATE/qa-profiles/<repo>.md"
```

Read `$PRIVATE/qa-profiles/<repo>.md`. It
tells you: the exact serve command + **port** + env it needs, how to get past auth and
seed a known state, how to force gated UI on, and the project's console/network gotchas.
If no profile exists for this repo, that's a `blocker` — write `QA-RESULT.md` with
`qa: fail` explaining a profile is missing, and stop.

## 3. Serve the app (per profile)

Follow the profile's serve section exactly — command, **port**, and required env vars
differ per repo, and the Runner has leased that port for you. Generic rules:

- Defensively free the port first (`lsof -ti :<port> | xargs kill -9 2>/dev/null || true`)
  — the Runner serializes it, but a stray bind happens.
- Fresh worktrees lack the gitignored `.env`; the profile says where to copy it from.
- Start detached (`nohup … > /tmp/loop-qa-server.log 2>&1 &`) and **poll** the URL until
  it answers (first Vite/compile pass is 10–60s — poll, don't sleep). If it never comes up
  or the log shows a build/proxy error, that's a `blocker`: write `qa: fail` and stop.
- Kill the server when you're done.

## 4. Drive the affected flow with Playwright

Bootstrap Playwright OUTSIDE the worktree so the repo's lint/format hooks never see it:

```bash
QA=$(mktemp -d /tmp/loop-qa-XXXXXX); cd "$QA"
npm init -y >/dev/null && npm i playwright >/dev/null && npx playwright install chromium
# some profiles need extra deps (e.g. @clerk/testing) — see the profile.
```

**Authenticate and seed state per the profile.** This is the part that differs most
between projects — wallet personas via `storageState`, a Clerk programmatic sign-in with a
shared test account, a dev-menu toggle, etc. Do exactly what `qa-profiles/<repo>.md` says,
then navigate to the affected route.

Driver script conventions (write it in `$QA`, run `node $QA/drive.mjs`) — these are
cross-project:

- `chromium.launch({ headless: true })`, context with `{ viewport: {width:1440,height:900}, userAgent, … }`
  (also drive 390×844 when the change is mobile-relevant). Pass `storageState` here only if
  the profile uses one.
- **Always set a real Chrome `userAgent` on the context** — some backends block the
  default Playwright headless UA and every API call dies with `net::ERR_FAILED` while the
  page itself boots (the profile's gotchas name the culprits). Use
  `"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"`
  and confirm a backend response returns `200` before trusting anything else.
- **Warm up before measuring.** A `200`/`307` on `/` does NOT mean the app is ready — Vite
  pre-bundles deps on the first real navigation, and that first load 504s on the not-yet-
  optimized chunks. So: `goto(affectedUrl)`, `waitForTimeout(6000)`, then `reload()` and do
  the *measured* pass on the reload. Attach the console/request listeners only for the
  measured pass.
- Collect failures, but **filter dev/localhost noise** — the dev console is loud by design.
  Generic noise (never an app bug): Vite pre-bundling and analytics/telemetry. The profile
  adds its app-specific noise hosts AND names its **real backend** host(s) — **never**
  noise-filter the backends; if they're failing the whole flow is dead and that's the
  headline finding, not noise.
  ```js
  // extend the regex with the profile's app-specific noise hosts
  const isNoise = (s) => /Outdated Optimize Dep|\.vite\/deps|504|google-analytics|googlesyndication|googletagmanager|mixpanel|tiktok|braze|beamer/i.test(s);
  page.on("console", m => m.type()==="error" && !isNoise(m.text()) && errors.push(m.text()));
  page.on("requestfailed", r => { const t=`${r.url()} ${r.failure()?.errorText??""}`; if(!isNoise(t)) failures.push(t); });
  ```
- Navigate/exercise the affected flow per the diff (open the modal, switch the tab, whatever
  the change touches), `waitForLoadState("networkidle")` (wrap in try/catch — the app polls,
  so networkidle may never fire) + explicit element waits.
- Screenshot into the worktree's artifact dir so the Runner can courier them:
  `await page.screenshot({ path: "<ABS_WORKTREE>/.qa-artifacts/01-<step>.png" })`.

Then **read the screenshots** (the Read tool renders images) and confirm with your own eyes
that the affected screen rendered — real data, not a blank page, not an error boundary, not
a stuck loading skeleton, not the sign-in wall. **The screenshot is ground truth; the
console log is not.** The console is full of expected localhost noise even when the page is
perfect — so a clean render with a noisy console is a `pass`. Trust your eyes over the
error count.

**For CSS-only / layout fixes, also assert numerically via `page.evaluate()`** — pixels
are hard to judge by eye and a passing-looking screenshot can hide a regression. Read the
`getComputedStyle()` properties and `getBoundingClientRect()` of the element under test
and check the specific values the diff was supposed to change (e.g. `alignContent` is now
`flex-start` not `stretch`; item heights are content-sized). Log the numbers in
`## Verification log` — evidence the fix is in the DOM, not just in the source.

## 5. Judge: pass or fail

This is a smoke gate, so the bar is **boots and renders**, not "looks perfect":

- `qa: fail` (`blocker`) — app won't build/start; couldn't authenticate / get past the
  sign-in wall; the affected route 404s/crashes; the changed screen shows an error
  boundary, stays blank, or never leaves the loading state; a *non-noise* console error
  breaks the flow (after filtering §4's noise); a gated change couldn't be made visible.
- `qa: fail` (`major`) — the affected flow is reachable but visibly broken (the new
  component doesn't render, throws on interaction, obvious layout collapse).
- `qa: pass` — it boots, the affected flow renders, you captured the screenshot. Cosmetic
  imperfections, design-match questions, and code nits are **NOT** your call — leave them
  for `/loop-review`. Do not fail the gate on them.

## 6. Write QA-RESULT.md (the contract)

Write to the worktree root, exactly this shape — the Runner parses the frontmatter
mechanically (same forgiving parser as the review doc):

```markdown
---
qa: pass
boots: true
visual_change: true
screenshots:
  - file: .qa-artifacts/01-overview.png
    label: Affected flow after change
  - file: .qa-artifacts/02-detail.png
    label: Secondary state
findings:
  - severity: blocker
    area: behavior
    title: Modal throws on open (only when qa is fail)
    file: src/features/foo/FooModal.tsx:88
---
## Summary

One paragraph: persona/account used, what flow was driven (head SHA), did it boot and render.

## Verification log
- Profile: <repo> — persona/account, any flag/dev-menu override
- Served: http://localhost:<port> (ready in 22s)
- Flows: <route> → <interaction>
- Console/network: clean   (or: list the errors)
```

Header rules — parsed mechanically, keep them exact:

- `qa:` is exactly `pass` or `fail`; `boots:`/`visual_change:` are `true`/`false`.
- `screenshots:` paths are relative to the worktree root, under `.qa-artifacts/`.
  `screenshots: []` only when the change is genuinely non-visual; when
  `visual_change: true` at least one is required — couldn't capture one ⇒ `qa: fail`.
- `findings:` justify a fail (`severity: blocker|major`, `area: build|behavior|visual`,
  `title`, optional `file`); `findings: []` when `qa: pass`.

## 7. Record solved blockers in the profile

If a problem stalled the QA process itself — serve wouldn't start, auth trick, port/CORS
gotcha, a flag override you had to hunt for, a missing dep, a noise-filter mistake — and
you found the fix, append it to the matching section of `$PRIVATE/qa-profiles/<repo>.md` before you
finish: one or two lines, symptom → cause → fix. If the lesson is cross-project (not tied
to one repo), amend §3/§4 of this file instead. This does not violate the hard rules: the
profiles live outside the worktree. `QA-RESULT.md` is consumed and cleared by the Runner,
so the profile is the only memory the next loop has — an unrecorded workaround will stall
the next run exactly the same way.

## 8. Wrap up

Reply with one short line: the verdict, whether it booted, and the screenshot count. The
Runner reads the doc, not your reply.
