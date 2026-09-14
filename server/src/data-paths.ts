/**
 * Layout of the runner's data dir (`DATA_DIR`). One place to know where
 * things live so the dir can be moved or restored wholesale. See ADR-0004.
 *
 *   config.json                          editable runner config (ADR-0003)
 *   runtime.json                         { pid, port } written on boot for Raycast
 *   db/runner.sqlite                     state DB (+ -shm/-wal)
 *   db/backups/                          manual/scripted DB snapshots
 *   loops/<ISSUE>/<loopId>/<n>/          one dir per loop iteration:
 *     review.md                            archived LOOP-REVIEW.md
 *     qa.md                                archived QA-RESULT.md
 *     screenshots/*.png                    archived QA screenshots
 *   qa/                                  QA *infrastructure* only — never per-loop output:
 *     fixtures/, load-persona.mjs          web-app storageState personas + loader
 *     personas/<repo>/<persona>/           other seeded personas (e.g. extension vault)
 *     secrets/                             credentials read by qa-profiles; never in git
 *   logs/ai-runner.log                   daemon stdout/stderr (launchd) + runner log
 *
 * Paths persisted in the DB (`iterations.review_doc_path`, `qa_doc_path`,
 * `qa_screenshots_json[].path`) are stored RELATIVE to the data dir so the
 * whole folder is relocatable. {@link resolveDataPath} turns them back into
 * absolute paths at read time and tolerates pre-migration absolute values.
 */
import path from "node:path";
import { config } from "./config";

export const DB_DIR = path.join(config.dataDir, "db");
export const DB_PATH = path.join(DB_DIR, "runner.sqlite");
export const DB_BACKUP_DIR = path.join(DB_DIR, "backups");
export const LOOPS_DIR = path.join(config.dataDir, "loops");
export const QA_INFRA_DIR = path.join(config.dataDir, "qa");
export const RUNTIME_JSON_PATH = path.join(config.dataDir, "runtime.json");

/** Archived file names inside an iteration dir. */
export const ARCHIVED_REVIEW_DOC = "review.md";
export const ARCHIVED_QA_DOC = "qa.md";
export const ARCHIVED_SCREENSHOTS_DIR = "screenshots";

/** Absolute dir for one loop iteration's archive: `loops/<ISSUE>/<loopId>/<n>`. */
export function iterationDir(issueIdentifier: string, loopId: string, iteration: number): string {
  return path.join(LOOPS_DIR, issueIdentifier, loopId, String(iteration));
}

/** A DB-storable path: relative to the data dir, POSIX separators. */
export function toStoredPath(absolute: string): string {
  return path.relative(config.dataDir, absolute).split(path.sep).join("/");
}

/**
 * Absolute path for a stored value. Relative values are joined onto the data
 * dir; absolute values (rows written before the layout migration) pass through.
 */
export function resolveDataPath(stored: string): string {
  return path.isAbsolute(stored) ? stored : path.join(config.dataDir, stored);
}
