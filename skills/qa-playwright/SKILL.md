---
name: qa-playwright
description: QA a pull request by running the app locally and driving it with a Playwright browser — screenshots, interaction checks, and a pass/fail report posted to the PR. Use when asked to QA a PR in a browser, verify a change visually, or when invoked as /qa-playwright <pr-url>. Assumes the working directory is already checked out at the PR's code (e.g. a fresh T3 Code worktree branched off the PR head).
---

# Playwright QA

## Quick start

Input: a GitHub PR URL (e.g. `https://github.com/zeriontech/zerion-web-app/pull/123`). The current worktree is already at the PR's code — do NOT check anything out. Workflow: derive a checklist from the PR → launch the app → drive it with Playwright → screenshot evidence → post a verdict comment on the PR.

You have a clean context on purpose: you did not implement this change. Judge only what you observe in the running app.

## 1. Build the checklist

1. `gh pr view <url> --json title,body,headRefName,number` — read the description and test plan.
2. If the body links a Linear issue, fetch it (Linear MCP `get_issue`) for the expected behavior and any designs.
3. `gh pr diff <url> --name-only` — see which routes/features are touched.
4. Write an explicit checklist of user-visible behaviors to verify: the changed flows first, then one smoke pass of adjacent screens (navigation works, no console errors, no broken layout). If the user passed extra instructions after the PR URL, fold them in as checklist items.

## 2. Launch the app

Look for project-specific launch instructions, in this order:

1. A project skill or doc: `.claude/skills/running-the-app/SKILL.md`, `.claude/commands/`, `CLAUDE.md`, `CONTEXT.md`.
2. `package.json` scripts (`dev`, `start`) — note the port and package manager (`packageManager` field).

Install deps first (`pnpm install` / `npm install` per lockfile). Start the dev server with a detached background process, redirect output to a log file, and poll the port until it responds (HTTP 200/3xx on `/`) before driving the browser. Vite apps typically need 10–60s for first compile. If the server fails to start, read the log, report the error, and stop — that is itself a QA finding.

Known repos:
- **zerion-web-app**: `pnpm install`, then `pnpm dev` → Vite on `http://localhost:3000`. See the project's `running-the-app` skill if present.

## 3. Set up Playwright

The repos do not depend on Playwright — bootstrap it outside the worktree so the repo stays clean:

```bash
QA_DIR=$(mktemp -d /tmp/qa-playwright-XXXXXX)
cd "$QA_DIR" && npm init -y >/dev/null && npm i playwright >/dev/null
npx playwright install chromium
```

Browser binaries cache in `~/Library/Caches/ms-playwright`, so installs after the first are fast. Write driver scripts in `$QA_DIR` (so they're not picked up by the repo's lint hooks) and run them with `node $QA_DIR/<script>.mjs`.

Script conventions:
- `chromium.launch({ headless: true })`, viewport 1440×900 (also check 390×844 for mobile-relevant changes).
- Collect console errors and failed requests on every page:
  ```js
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("requestfailed", (r) => failures.push(`${r.url()} ${r.failure()?.errorText}`));
  ```
- Screenshot every checklist step into `$QA_DIR/screenshots/<nn>-<step>.png` — before AND after each interaction, full page for layout checks.
- Prefer role/text selectors (`getByRole`, `getByText`) over CSS classes; the apps use generated class names.
- `waitForLoadState("networkidle")` plus an explicit wait for the element under test; never bare timeouts over 5s.

After each script run, READ the screenshots (the Read tool renders images) and judge them yourself: layout, content, loading/error states. A screenshot you didn't look at is not evidence.

## 4. Auth and data

- If a flow needs a logged-in state, check the project launch skill for test credentials or storage-state fixtures. If none exist, verify what is reachable logged-out, and list the rest as "not verifiable — no test login" in the report. Never use personal/production credentials.
- Read-only checks only: do not submit transactions, send funds, or mutate remote state. Form validation may be tested up to (not including) final submission.

## 5. Report

Post one comment on the PR via `gh pr comment <url> --body-file <file>`:

```markdown
## Playwright QA — <pass ✅ | issues found ⚠️ | blocked ⛔>

Tested at `<head-sha>` on `http://localhost:<port>`.

### Checklist
- ✅ <behavior> — <what was observed>
- ⚠️ <behavior> — <what's wrong, with exact repro steps>
- ⏭️ <behavior> — not verifiable (<why>)

### Console / network
<errors seen, or "clean">

### Environment
<node version, browser, viewport(s)>
```

Keep screenshots in `$QA_DIR` and reference key findings by filename in the comment (GitHub comments can't attach local files; describe what the screenshot shows). End your session summary to the user with the verdict, the comment URL, and the screenshot directory path.

## 6. Cleanup

Kill the dev server process you started. Leave `$QA_DIR` in place (the user may want the screenshots) but mention its path.

## Notes

- Do not modify repo files and do not commit or push anything — this is an observe-and-report session. Fixes happen in the implementation thread, driven by your PR comment.
- If the app cannot build/start from the PR's code, that is a ⛔ blocked verdict — report it on the PR with the build error.
