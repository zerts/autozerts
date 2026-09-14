# QA profile — <repo>

<!--
Copy to qa-profiles/<repo>.md where <repo> is `basename $(git remote get-url origin)`
without `.git`. /loop-qa reads this file after `git reset --hard origin/<pr-head>`
inside a fresh T3 worktree of the target repo, then follows it literally.
Be concrete: exact commands, exact ports, exact paths. Delete these comments.
-->

One paragraph: stack (framework, router, auth provider, data layer, package
manager), whether there is a sign-in wall, and what a "rendered" screen looks
like. Canonical clone path and default branch.

Canonical repo: `/absolute/path/to/<repo>` (remote `<org>/<repo>`, default branch `main`). `pnpm`.

## Serve — port <PORT>

<!--
Must match the repo's `qaPort` on the Runner Config page; the Runner leases that
port so only one loop binds it at a time. Fresh worktrees lack gitignored .env
files — say where to copy them from. Start detached and poll; never sleep.
-->

```bash
lsof -ti :<PORT> | xargs kill -9 2>/dev/null || true
[ -f .env ] || cp /absolute/path/to/<repo>/.env .env         # gitignored; copy from the canonical clone
pnpm install
nohup pnpm dev --port <PORT> > /tmp/loop-qa-server.log 2>&1 &  # → http://localhost:<PORT>
```

Poll `http://localhost:<PORT>/` until it answers (first compile 10–60 s). Required
env: `<VAR_ONE>`, `<VAR_TWO>` — without them the app <what breaks>.

## Authenticate / seed

<!--
The part that differs most between projects. Pick one pattern and spell it out:
  a) no auth — just navigate;
  b) Playwright storageState fixture from DATA_DIR/qa/fixtures/<persona>.json;
  c) programmatic sign-in with a shared TEST account whose creds live in
     DATA_DIR/qa/secrets/<repo>.json (never a real user, never MFA);
  d) a dev menu / mock toggle that seeds state.
Say which persona/account to use, what data it is expected to have, and how to
tell the sign-in wall from the real screen.
-->

Credentials live OUTSIDE git in `$DATA_DIR/qa/secrets/<repo>.json`:

```json
{ "email": "...", "password": "..." }
```

Driver sketch (`$QA/drive.mjs`):

```js
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  // storageState: process.env.DATA_DIR + "/qa/fixtures/<persona>.json",   // pattern (b)
});
const page = await ctx.newPage();
// pattern (c): sign in here, then assert you are past the wall
await page.goto("http://localhost:<PORT>/<affected-route>");
```

## Force gated UI on

<!--
Feature flags, experiments, tier checks, dev menus. How does the agent make a
change hidden behind a gate visible? If there are no gates, say "None".
-->

None yet.

## Console / network gotchas

<!--
Two lists. Noise: hosts/messages that are always loud on localhost and never an
app bug (analytics, HMR). Backends: the real API hosts — NEVER noise-filter
these; if they fail the whole flow is dead and that is the headline finding.
-->

- **Real backends (never filter):** `api.<yourdomain>`, `<other-host>`
- **Noise (safe to ignore):** `analytics.<vendor>`, Vite `Outdated Optimize Dep`
- Known quirks: <e.g. "first navigation 504s on unoptimized chunks — reload once">

## Solved blockers

<!-- /loop-qa appends here: symptom → cause → fix, one or two lines each. -->
