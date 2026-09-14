# CLAUDE.md

Guidance for working in this repo. See [`CONTEXT.md`](./CONTEXT.md) for the full
domain glossary, [`docs/prd/ai-runner.md`](./docs/prd/ai-runner.md) for the spec,
and [`docs/adr/`](./docs/adr/) for decisions.

## What this is

A local background server (the **Runner**) that owns all communication with T3
Code. It supervises implement→review **Loops** on Linear tasks, exposes an HTTP
API for external triggers (Raycast), and serves a web dashboard. Input: a Linear
task. Output: a GitHub PR, iterated until a Playwright-backed review approves it
(max 5 iterations).

## Layout

- `server/src/` — the Runner (Bun + Hono). Entry: `index.ts` (serves the API and
  the built web UI). Loop logic in `engine/`; T3 Code integration in `t3/`;
  Linear/GitHub clients in `linear.ts` / `github.ts`.
- `web/` — Vite + React + Tailwind v4 + shadcn/ui dashboard. Built to `web/dist`.
- `skills/` — the Claude Code skills the Runner dispatches by name
  (`/linear-implement`, `/loop-qa`, `/loop-review`, `/address-review`) plus
  `/qa-playwright`, which `/address-review` builds on. Symlinked into
  `~/.claude/skills` by `bun run install-skills`; edit them here.
- `../autozerts-private/` — **sibling private repo** (not in this tree): per-repo
  QA profiles (`qa-profiles/<repo>.md`, read by `/loop-qa`) and internal docs.
  Skills resolve it relative to this checkout, so keep the two side by side.
- `docs/` — `prd/`, `adr/`.

## Commands

```bash
bun run dev                  # server with --watch (dev)
bun run --cwd web dev        # Vite dev server, proxies /api to :4777
bun run build:web            # build web/dist (REQUIRED for UI changes to show)
bun run start                # run server from source → http://127.0.0.1:4777
cd server && bun test        # unit tests
cd server && bunx tsc --noEmit
```

Background service (launchd, starts at login, restarts on crash):

```bash
bun run install-skills             # link skills/ into ~/.claude/skills
bun run install-agent              # install + start
bun run install-agent --uninstall  # remove
launchctl kickstart -k gui/$(id -u)/com.autozerts.ai-runner   # restart
```

## Critical gotchas

- **The server serves the *built* `web/dist`** (`server/src/index.ts`), not the
  Vite source. Any web/UI change requires `bun run build:web` to appear in the
  running app — restarting the daemon alone is not enough.
- **The launchd agent runs `server/src/index.ts` directly** (no server build
  step). Server changes need a daemon restart (`launchctl kickstart -k …`) to
  take effect; the running PID does not hot-reload.
- Static web assets live in `web/public/` (served at `/`), e.g. `favicon.png`.

## Conventions

- Runtime is **Bun** throughout (`bun:sqlite`, `Bun.serve`, `bun test`) — not Node.
- Persisted Loop state is re-derived from T3's turn log + `gh` on restart before
  acting; dispatches are recorded before sending. Preserve that invariant.
- One Loop per Linear task; one Implementation Thread + one reused Review Thread
  per Loop. See ADR-0001/0002 before changing the Review Doc or thread model.
