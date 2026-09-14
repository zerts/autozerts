# One Relocatable Data Dir: `loops/` per Iteration, `qa/` for Infrastructure Only

The runner's `DATA_DIR` grew by accretion: the review courier wrote `reviews/<ISSUE>/<loopId>/<n>.md`, the QA courier wrote `qa/<ISSUE>/<loopId>/<n>/QA-RESULT.md` + `screenshots/`, and the same `qa/` folder also held hand-maintained QA infrastructure (`fixtures/`, `secrets/`, seeded extension vaults). The sqlite DB and ad-hoc `.bak-*` copies sat in the root, and every archived path was stored in the DB as an absolute path, so the folder could not be moved or restored elsewhere without breaking the dashboard.

Decision — the layout is defined once in `server/src/data-paths.ts`:

```
config.json, runtime.json
db/runner.sqlite (+ -shm/-wal), db/backups/
loops/<ISSUE>/<loopId>/<n>/review.md | qa.md | screenshots/*.png
qa/fixtures/, qa/load-persona.mjs, qa/personas/<repo>/<persona>/, qa/secrets/
logs/ai-runner.log
```

- **One dir per loop iteration.** Everything the couriers produce for `(issue, loop, iteration)` lands in a single `loops/…/<n>/` dir. Both writers (`archiveReviewDoc`, `archiveQaArtifacts`) and all three readers (the review/QA/screenshot API routes, plus the engine's fix-message reader) go through `data-paths.ts`.
- **`qa/` is infrastructure only.** Per-loop output never goes there again, so the hand-maintained personas and secrets have no neighbours with an append-only lifecycle, and the served-over-HTTP artifacts are no longer adjacent to credentials.
- **DB paths are relative to `DATA_DIR`.** `iterations.review_doc_path`, `qa_doc_path`, and `qa_screenshots_json[].path` are stored data-dir-relative and resolved at read time by `resolveDataPath`, which still accepts absolute values so a half-migrated DB degrades gracefully. Anything that shells out with a path (the `qa-artifacts` git upload) resolves first.
- **Logs live in the data dir** by default (`LOG_FILE` still overrides), so one folder is the whole operational state.
- **Docs do not live in the data dir.** READMEs for fixtures/secrets/personas moved to `autozerts-private/docs/qa-data/`.

Migration is `bun run migrate-data` (`server/scripts/migrate-data-layout.ts`): idempotent, DB-row-driven (it moves exactly what the iteration rows reference and rewrites them), parks anything unreferenced under `loops/_unreferenced/` instead of deleting, and snapshots the DB into `db/backups/` first. Requires the daemon to be stopped. The legacy issue-level fallback in the review route was removed since every pre-namespacing doc was already referenced by its iteration row.

Not done here: retention/pruning of terminal loops' artifacts, and scripted DB backups — `db/backups/` is the agreed home for both when they arrive.
