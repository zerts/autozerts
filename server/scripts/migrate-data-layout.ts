/**
 * One-shot, idempotent migration of DATA_DIR to the layout in
 * server/src/data-paths.ts (ADR-0004):
 *
 *   runner.sqlite*                → db/runner.sqlite*
 *   runner.sqlite.bak-*           → db/backups/runner-<stamp>.sqlite
 *   reviews/<I>/<loop>/<n>.md     → loops/<I>/<loop>/<n>/review.md
 *   qa/<I>/<loop>/<n>/QA-RESULT.md→ loops/<I>/<loop>/<n>/qa.md
 *   qa/<I>/<loop>/<n>/screenshots → loops/<I>/<loop>/<n>/screenshots
 *   qa/extension/<persona>        → qa/personas/extension/<persona>
 *   <old LOG_FILE>                → logs/ai-runner.log (copied, if given via --old-log)
 *
 * Stored paths on `iterations` are rewritten to be relative to DATA_DIR. Files
 * are moved by following the DB rows, so nothing the dashboard can reach is
 * lost; anything left in reviews/ or qa/<ISSUE>/ that no row references is
 * parked under loops/_unreferenced/ rather than deleted.
 *
 * STOP THE DAEMON FIRST (it holds the sqlite WAL open):
 *   launchctl bootout gui/$(id -u)/com.autozerts.ai-runner
 *   bun run server/scripts/migrate-data-layout.ts [--dry-run] [--old-log <path>]
 *   bun run install-agent
 */
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { config } from "../src/config";

const DRY = process.argv.includes("--dry-run");
const oldLogArg = process.argv.indexOf("--old-log");
const OLD_LOG = oldLogArg >= 0 ? process.argv[oldLogArg + 1] : null;

const root = config.dataDir;
const dbDir = path.join(root, "db");
const dbPath = path.join(dbDir, "runner.sqlite");
const backupsDir = path.join(dbDir, "backups");
const loopsDir = path.join(root, "loops");
const unreferencedDir = path.join(loopsDir, "_unreferenced");

const say = (...a: unknown[]) => console.log(DRY ? "[dry-run]" : "[migrate]", ...a);

function mv(from: string, to: string): void {
  if (!fs.existsSync(from)) return;
  if (fs.existsSync(to)) {
    say(`skip (exists): ${rel(to)}`);
    return;
  }
  say(`${rel(from)} → ${rel(to)}`);
  if (DRY) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}
const rel = (p: string) => path.relative(root, p) || ".";
const isIssueDir = (name: string) => /^[A-Z][A-Z0-9]*-\d+$/.test(name);

/** Remove a dir tree that contains only empty dirs and .DS_Store files. */
function pruneEmpty(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (fs.statSync(p).isDirectory()) pruneEmpty(p);
  }
  const left = fs.readdirSync(dir).filter((e) => e !== ".DS_Store");
  if (left.length === 0) {
    say(`rmdir ${rel(dir)}`);
    if (!DRY) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. Database → db/
// ---------------------------------------------------------------------------
if (fs.existsSync(path.join(root, "runner.sqlite-wal")) && fs.statSync(path.join(root, "runner.sqlite-wal")).size > 0) {
  console.error("runner.sqlite-wal is non-empty — the daemon is probably still running. Stop it first.");
  process.exit(1);
}
if (!DRY) fs.mkdirSync(backupsDir, { recursive: true });
mv(path.join(root, "runner.sqlite"), dbPath);
for (const suffix of ["-shm", "-wal"]) mv(path.join(root, `runner.sqlite${suffix}`), `${dbPath}${suffix}`);
for (const entry of fs.readdirSync(root)) {
  const m = entry.match(/^runner\.sqlite\.bak-(.+)$/);
  if (m) mv(path.join(root, entry), path.join(backupsDir, `runner-${m[1]}.sqlite`));
}

// Fresh pre-migration snapshot so the path rewrite below is reversible.
if (fs.existsSync(dbPath) && !DRY) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const snap = path.join(backupsDir, `runner-${stamp}-pre-layout.sqlite`);
  fs.copyFileSync(dbPath, snap);
  say(`snapshot → ${rel(snap)}`);
}

// ---------------------------------------------------------------------------
// 2. Per-iteration archives → loops/<ISSUE>/<loopId>/<n>/
// ---------------------------------------------------------------------------
interface Row {
  loop_id: string;
  n: number;
  issue_identifier: string;
  review_doc_path: string | null;
  qa_doc_path: string | null;
  qa_screenshots_json: string | null;
}

const toStored = (abs: string) => path.relative(root, abs).split(path.sep).join("/");
const resolveStored = (p: string) => (path.isAbsolute(p) ? p : path.join(root, p));

// In dry-run nothing moved yet, so read the DB from wherever it currently is.
const liveDbPath = fs.existsSync(dbPath) ? dbPath : path.join(root, "runner.sqlite");
if (fs.existsSync(liveDbPath)) {
  const db = DRY ? new Database(liveDbPath, { readonly: true }) : new Database(liveDbPath);
  const rows = db
    .query(
      `SELECT it.loop_id, it.n, l.issue_identifier, it.review_doc_path, it.qa_doc_path, it.qa_screenshots_json
       FROM iterations it JOIN loops l ON l.id = it.loop_id
       WHERE it.review_doc_path IS NOT NULL OR it.qa_doc_path IS NOT NULL OR it.qa_screenshots_json IS NOT NULL`,
    )
    .all() as Row[];

  const update = DRY
    ? null
    : db.query("UPDATE iterations SET review_doc_path = ?, qa_doc_path = ?, qa_screenshots_json = ? WHERE loop_id = ? AND n = ?");

  let moved = 0;
  for (const row of rows) {
    const dir = path.join(loopsDir, row.issue_identifier, row.loop_id, String(row.n));

    let review = row.review_doc_path;
    if (review) {
      const src = resolveStored(review);
      const dest = path.join(dir, "review.md");
      if (src !== dest) mv(src, dest);
      review = toStored(dest);
    }

    let qa = row.qa_doc_path;
    if (qa) {
      const src = resolveStored(qa);
      const dest = path.join(dir, "qa.md");
      if (src !== dest) mv(src, dest);
      qa = toStored(dest);
    }

    let shots = row.qa_screenshots_json;
    if (shots) {
      const images = JSON.parse(shots) as Array<{ path: string; label?: string }>;
      const rewritten = images.map((img) => {
        const src = resolveStored(img.path);
        const dest = path.join(dir, "screenshots", path.basename(src));
        if (src !== dest) mv(src, dest);
        return { ...img, path: toStored(dest) };
      });
      shots = JSON.stringify(rewritten);
    }

    if (review !== row.review_doc_path || qa !== row.qa_doc_path || shots !== row.qa_screenshots_json) {
      update?.run(review, qa, shots, row.loop_id, row.n);
      moved++;
    }
  }
  say(`iterations rewritten: ${moved}/${rows.length}`);
  db.close();
}

// Anything left behind under reviews/ or qa/<ISSUE>/ is unreferenced: park it.
function parkLeftovers(base: string, filter: (name: string) => boolean): void {
  if (!fs.existsSync(base)) return;
  for (const entry of fs.readdirSync(base)) {
    if (!filter(entry)) continue;
    const src = path.join(base, entry);
    pruneEmpty(src);
    if (!fs.existsSync(src)) continue;
    mv(src, path.join(unreferencedDir, path.basename(base), entry));
  }
}
if (DRY) {
  say("(skipping leftover scan — only meaningful after files have actually moved)");
} else {
  parkLeftovers(path.join(root, "reviews"), () => true);
  parkLeftovers(path.join(root, "qa"), isIssueDir);
  pruneEmpty(path.join(root, "reviews"));
}

// ---------------------------------------------------------------------------
// 3. QA infrastructure tidy-up
// ---------------------------------------------------------------------------
const oldExt = path.join(root, "qa", "extension");
if (fs.existsSync(oldExt)) {
  for (const entry of fs.readdirSync(oldExt)) {
    if (entry === ".DS_Store" || entry.endsWith(".md")) continue; // docs move to autozerts-private by hand
    mv(path.join(oldExt, entry), path.join(root, "qa", "personas", "extension", entry));
  }
  pruneEmpty(oldExt);
}

// ---------------------------------------------------------------------------
// 4. Logs → logs/ai-runner.log
// ---------------------------------------------------------------------------
if (OLD_LOG) {
  const dest = path.join(root, "logs", "ai-runner.log");
  if (fs.existsSync(OLD_LOG) && !fs.existsSync(dest)) {
    say(`${OLD_LOG} → ${rel(dest)} (copy)`);
    if (!DRY) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(OLD_LOG, dest);
    }
  }
}

say("done");
