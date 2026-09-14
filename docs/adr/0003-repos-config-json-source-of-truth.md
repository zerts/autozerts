# `config.json` is the Source of Truth for Repos

Repo→issue matching (names, paths, branches, `issuePrefixes`, `labels`, icons) used to live only in the `REPOS` env var, so adding label support for a new project meant hand-editing `.env` JSON and restarting the daemon. The repos array now lives in an editable `DATA_DIR/config.json`, written by the Config page via `PUT /api/config/repos` and hot-applied to the in-memory `config.repos` (no daemon restart). `saveRepos` validates required fields + unique names and writes atomically (temp file + rename).

Precedence is **config.json wins**: a valid `repos` array in config.json is authoritative; env `REPOS` is only the seed used when no config.json exists yet. No file is written on boot — config.json is created lazily on the first save, so existing env-only setups keep working until the first UI edit.

Scope is deliberately repos-only. `LINEAR_API_KEY` (secret) stays in `.env` and is never written to config.json or sent to the UI; bootstrap paths (`PORT`, `DATA_DIR`, `LOG_FILE`) and operational knobs (`CLAUDE_MODEL`, `MAX_*`) remain read-only env values, surfaced on the Config page for visibility. The known cost: config lives in two places (env seed + config.json). Mitigated by config.json winning unambiguously when present, so a stale `REPOS` in `.env` never silently shadows a UI edit.
