---
name: runner-setup
description: Guided first-run setup for the AI Runner (autozerts) on this machine — checks prerequisites with `bun run doctor`, walks the user through T3 Code, Linear, GitHub, repos, the private sibling repo with per-repo QA profiles, secrets placement, and the background service, then smoke-tests the daemon. Idempotent; safe to re-run to diagnose a broken install. Use when invoked as /runner-setup, when a user has just cloned autozerts, or when `bun run doctor` reports failures.
---

# Runner setup

You are onboarding someone onto the AI Runner. Their machine may have nothing
installed, or may be half-configured. Your job is to get `bun run doctor` to
report zero failures and end with the dashboard open, without ever seeing a
secret value yourself.

Run from the `autozerts` repo root. If the cwd is not the repo (no
`server/scripts/doctor.ts`), ask for the path first.

## Hard rules

- **Never ask the user to paste a secret into the chat.** API keys, passwords,
  test-account credentials go straight into files (`.env`,
  `DATA_DIR/qa/secrets/`). Tell them exactly which file and which line, wait,
  then re-run `doctor` to confirm presence. Never `cat` those files back; use
  `grep -c` or `doctor` to verify.
- **Never edit the public repo to personalize it.** Everything user-specific
  lives in `.env`, `DATA_DIR`, or `../autozerts-private`. If you find yourself
  wanting to change a skill or `web/src`, stop and tell the user that value
  should become config; don't do it.
- **Idempotent.** Detect before you ask. Re-running on a working machine must
  produce "all green" and no questions.
- **One phase at a time.** Finish and verify a phase before opening the next.
  A half-done session should still leave usable state on disk.

## 0. Diagnose

```bash
bun install
bun run doctor --json
```

Read the JSON. `checks[]` carries `id`, `phase`, `status` (`ok|warn|fail|skip`),
`title`, `detail`, `fix`. Show the user a compact checklist grouped by phase
(one line per check, ✔/!/✘). Then work through the phases below **in order,
skipping any phase whose checks are all ok**. `fail` blocks; `warn` is
informational — mention it once and move on unless the user wants it fixed.

## 1. Prerequisites (`phase: prereqs`)

- `gh` missing or unauthenticated → the `fix` field has the command. Run
  `gh auth login` **in the user's terminal**, not via a tool (it is interactive).
- Playwright warning → offer `npx playwright install chromium` now (it is
  slow later, during a real QA run).
- Non-macOS → say the background service is unavailable and they'll use
  `bun run start`; skip phase 7.

## 2. T3 Code (`phase: t3`)

This runner drives T3 Code through internal, undocumented interfaces (a local
HMAC signing key and the orchestration websocket). Be upfront about that.

- `t3.userdata` / `t3.signing-key` / `t3.session` fail → the user must install
  T3 Code, open it, and sign in. Nothing else can proceed. Wait, re-run doctor.
- `t3.runtime` warn → T3 is installed but not running; ask them to launch it.

## 3. Claude Code (`phase: claude`)

- `claude.skills` fail → run `bun run install-skills`. If it reports a
  `skip … already exists and is not a link`, show the user the conflicting
  path and ask before removing anything.
- `claude.linear-mcp` warn → the skills need Linear MCP tools
  (`mcp__claude_ai_Linear__get_issue`, `list_comments`, `save_comment`).
  Ask which they use: the claude.ai Linear connector (nothing local to check;
  ask them to confirm it's enabled) or a local MCP server. Only Linear is
  supported as a tracker today; if they use something else, say so plainly and
  point at `server/src/linear.ts` as the extension point. Do not promise more.

## 4. Environment (`phase: env`)

- `env.file` warn → `cp .env.example .env`, then open it for them.
- `env.linear-key` fail → explain: Linear → Settings → API → Personal API keys.
  Tell them to paste it after `LINEAR_API_KEY=` in `.env` and say "done".
  Re-run doctor; it validates the key against the API and prints the
  workspace name so they can confirm it's the right one.
- Ask about `CLAUDE_MODEL` only if they raise it; the default is fine.
- `DATA_DIR`: default `~/.ai-runner/data`. Ask only if they already have a
  data dir from another machine to reuse.

## 5. Repos (`phase: repos`)

Ask which local repos the Runner should work on. For each, collect:

| field | how to get it |
|---|---|
| `name` | short slug; default to the directory basename |
| `localPath` | absolute path; verify it exists and is a git repo |
| `defaultBranch` | `git -C <path> symbolic-ref refs/remotes/origin/HEAD` → `main`/`master` |
| `issuePrefixes` | the Linear title prefix(es) that route issues here, e.g. `["Web"]`; ask |
| `labels` | optional; Linear label names; defaults to prefixes |
| `qaGate` | ask "Should PRs be smoke-tested in a browser before review?" — only for web apps they can run locally |
| `qaPort` | if qaGate: the dev-server port; read it from `package.json` scripts / vite config and confirm |
| `icon` | optional; look for `public/favicon*` and offer it |

Write them into `REPOS=` in `.env` as one JSON line (this is the *seed*; once
they edit repos on the dashboard Config page, `DATA_DIR/config.json` wins).
Re-run doctor: each repo gets a `repos.<name>` check.

- `repos.<name>` warn "not registered as a T3 Code project" → they must add the
  folder as a project inside T3 Code (File → Add project). Dispatch cannot
  create threads for unknown projects. Wait, re-run.

## 6. Private sibling + QA profiles (`phase: private`, `phase: data`)

Only needed if any repo has `qaGate: true`. Otherwise say so and skip.

1. `private.dir` missing →
   ```bash
   cp -R templates/private-repo ../autozerts-private
   cd ../autozerts-private && git init -q && git add -A && git commit -qm "Init private companion" && cd -
   ```
   Tell them this repo is theirs to push to a **private** remote or keep local.

2. For each `repos.<name>.qa-profile` fail, **draft the profile by
   inspection, then confirm the unknowns**:
   - Read the target repo's `package.json` (dev script, package manager), vite /
     next / framework config (port), `.env.example` (required vars).
   - Copy `qa-profiles/_example.md` to `qa-profiles/<remote-basename>.md` and
     fill **Serve** from what you found.
   - Ask, in one message, the things you cannot infer:
     - Is there a sign-in wall? Which pattern: none / storageState fixture /
       shared test account / dev toggle?
     - Which route shows the app is "up" and what does a healthy render look like?
     - Real backend hosts (never to be noise-filtered) vs noisy analytics hosts.
     - Any feature-flag system and how to force a flag on locally.
   - Write **Authenticate / seed**, **Force gated UI on**, **Console / network
     gotchas** from their answers. Leave `Solved blockers` empty; `/loop-qa`
     appends to it.
3. If a test account is involved: `mkdir -p "$DATA_DIR/qa/secrets"`, create
   `<repo>.json` with placeholder keys (`{"email":"","password":""}`), tell the
   user to fill the values there, and reference that path from the profile.
   Remind them: test account only, no MFA, never a real user.
4. Re-run doctor until `private` and `data` are green.

## 7. Service (`phase: service`)

- `service.web-dist` fail → `bun run build:web`.
- Ask: run as a background service (macOS launchd, starts at login, restarts
  on crash) or start manually? Background → `bun run install-agent`. Manual →
  they run `bun run start` in a terminal.
- **Smoke test.** With the server running:
  ```bash
  curl -s http://127.0.0.1:${PORT:-4777}/api/health
  ```
  Expect `t3: "up"`, `gh: "ok"`, `linearConfigured: true`, and their repo
  names. If `t3` is `down`, T3 Code isn't running.
- Open `http://127.0.0.1:4777` for them (`open …` on macOS). Point at the
  **Tasks** page (their assigned Linear issues should appear) and **Config**
  (where repos are edited from now on).

## 8. Wrap up

Run `bun run doctor` one last time and show the final checklist. Then, in a few
lines:

- What was created where (`.env`, `../autozerts-private`, `DATA_DIR`, launchd
  label `com.autozerts.ai-runner` if installed).
- How a loop starts: pick a task on `/tasks` → the runner opens a T3 thread and
  posts `/linear-implement`; grilling questions appear in T3 Code.
- Remaining warnings, if any, and that `/runner-setup` can be re-run anytime.

Do not summarize this file back to them; the checklist is the summary.
