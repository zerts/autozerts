/**
 * Runner persistence (runner.sqlite in DATA_DIR). The dispatch journal is the
 * crash-recovery backbone: every intended turn is recorded BEFORE sending and
 * confirmed against T3's message log afterwards, so a restart never blindly
 * re-dispatches.
 */
import path from "node:path";
import fs from "node:fs";
import { Database } from "bun:sqlite";
import { config } from "./config";

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new Database(path.join(config.dataDir, "runner.sqlite"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS loops (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  issue_identifier TEXT NOT NULL,
  issue_title TEXT NOT NULL,
  issue_url TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  state TEXT NOT NULL,              -- queued|running|blocked|paused|approved|exhausted|cancelled|error
  phase TEXT NOT NULL,              -- implementing|qa|reviewing|fixing
  step TEXT,                        -- engine micro-step: impl|gate|qa-start|qa-dispatch|review-start|review-dispatch|fix-start|fix-dispatch|push-gate
  round TEXT NOT NULL DEFAULT 'initial', -- initial|address-review
  iteration INTEGER NOT NULL DEFAULT 1,
  max_iterations INTEGER NOT NULL,
  task_branch TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  dev_build_url TEXT,               -- CI "deployed to domain" link; captured once, then reused
  autonomous INTEGER NOT NULL DEFAULT 0,
  force_grill INTEGER NOT NULL DEFAULT 0,
  model TEXT,                       -- T3 Claude slug for implementation; null → config default
  review_model TEXT,                -- T3 Claude slug for review; null reuses the implementation model
  extras TEXT,
  blocked_reason TEXT,
  error_message TEXT,
  resume_state TEXT,                -- state to restore when leaving paused
  qa_probe TEXT,                    -- JSON {state,phase,step,terminalAt} to restore after a manual QA probe; null otherwise
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_loops_one_active_per_issue
  ON loops(issue_id) WHERE state NOT IN ('approved','exhausted','cancelled');

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  loop_id TEXT REFERENCES loops(id),
  issue_id TEXT NOT NULL,
  role TEXT NOT NULL,               -- implementation|review|interactive
  t3_thread_id TEXT NOT NULL,
  branch TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_loop ON threads(loop_id);
CREATE INDEX IF NOT EXISTS idx_threads_issue ON threads(issue_id);

CREATE TABLE IF NOT EXISTS dispatches (
  id TEXT PRIMARY KEY,
  loop_id TEXT REFERENCES loops(id),
  t3_thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- first|qa|qa-probe|review-first|review|fix|compact-impl|compact-review|address-review|nudge-push|interactive
  text TEXT NOT NULL,
  dispatched_at TEXT NOT NULL,      -- intent time, written BEFORE sending
  confirmed_at TEXT,                -- set once send succeeded (or message found in T3)
  settled_at TEXT,
  outcome TEXT                      -- completed|error|no-turn|timeout
);
CREATE INDEX IF NOT EXISTS idx_dispatches_loop ON dispatches(loop_id, dispatched_at);

CREATE TABLE IF NOT EXISTS iterations (
  id TEXT PRIMARY KEY,
  loop_id TEXT NOT NULL REFERENCES loops(id),
  n INTEGER NOT NULL,
  verdict TEXT,                     -- approved|needs-changes
  findings_json TEXT,
  review_doc_path TEXT,
  qa_verdict TEXT,                  -- pass|fail (QA smoke gate, when the repo opts in)
  qa_doc_path TEXT,                 -- archived QA-RESULT.md
  qa_screenshots_json TEXT,         -- [{ path, label? }] of archived screenshots
  qa_reviewed_at TEXT,
  remote_sha_before TEXT,
  remote_sha_after TEXT,
  started_at TEXT NOT NULL,
  reviewed_at TEXT,
  UNIQUE (loop_id, n)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loop_id TEXT REFERENCES loops(id),
  kind TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_loop ON events(loop_id, id);
`);

// Additive migrations for columns introduced after the initial schema. Each is
// guarded so re-running against an up-to-date DB is a no-op.
for (const [table, col, type] of [
  ["loops", "dev_build_url", "TEXT"],
  ["loops", "model", "TEXT"],
  ["loops", "review_model", "TEXT"],
  ["loops", "qa_probe", "TEXT"],
  ["iterations", "qa_verdict", "TEXT"],
  ["iterations", "qa_doc_path", "TEXT"],
  ["iterations", "qa_screenshots_json", "TEXT"],
  ["iterations", "qa_reviewed_at", "TEXT"],
] as const) {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

export type LoopState =
  | "queued"
  | "running"
  | "blocked"
  | "paused"
  | "approved"
  | "exhausted"
  | "cancelled"
  | "error";
export type LoopPhase = "implementing" | "qa" | "reviewing" | "fixing";
export type LoopStep =
  | "impl"
  | "gate"
  | "qa-start"
  | "qa-dispatch"
  | "review-start"
  | "review-dispatch"
  | "fix-start"
  | "fix-dispatch"
  | "push-gate";
export type LoopRound = "initial" | "address-review";
export type DispatchKind =
  | "first"
  | "qa"
  | "qa-probe"
  | "review-first"
  | "review"
  | "fix"
  | "compact-impl"
  | "compact-review"
  | "address-review"
  | "nudge-push"
  | "interactive";

export interface LoopRow {
  id: string;
  issue_id: string;
  issue_identifier: string;
  issue_title: string;
  issue_url: string;
  repo_name: string;
  state: LoopState;
  phase: LoopPhase;
  step: LoopStep | null;
  round: LoopRound;
  iteration: number;
  max_iterations: number;
  task_branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  dev_build_url: string | null;
  autonomous: number;
  force_grill: number;
  model: string | null;
  review_model: string | null;
  extras: string | null;
  blocked_reason: string | null;
  error_message: string | null;
  resume_state: string | null;
  qa_probe: string | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

export interface ThreadRow {
  id: string;
  loop_id: string | null;
  issue_id: string;
  role: "implementation" | "review" | "interactive";
  t3_thread_id: string;
  branch: string | null;
  created_at: string;
}

export interface DispatchRow {
  id: string;
  loop_id: string | null;
  t3_thread_id: string;
  message_id: string;
  kind: DispatchKind;
  text: string;
  dispatched_at: string;
  confirmed_at: string | null;
  settled_at: string | null;
  outcome: string | null;
}

export interface IterationRow {
  id: string;
  loop_id: string;
  n: number;
  verdict: string | null;
  findings_json: string | null;
  review_doc_path: string | null;
  qa_verdict: string | null;
  qa_doc_path: string | null;
  qa_screenshots_json: string | null;
  qa_reviewed_at: string | null;
  remote_sha_before: string | null;
  remote_sha_after: string | null;
  started_at: string;
  reviewed_at: string | null;
}

const now = () => new Date().toISOString();

export const loopsRepo = {
  insert(row: Omit<LoopRow, "created_at" | "updated_at" | "terminal_at" | "qa_probe">): void {
    db.query(
      `INSERT INTO loops (id, issue_id, issue_identifier, issue_title, issue_url, repo_name,
         state, phase, step, round, iteration, max_iterations, task_branch, pr_number, pr_url,
         dev_build_url, autonomous, force_grill, model, review_model, extras, blocked_reason, error_message, resume_state,
         created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.id, row.issue_id, row.issue_identifier, row.issue_title, row.issue_url, row.repo_name,
      row.state, row.phase, row.step, row.round, row.iteration, row.max_iterations,
      row.task_branch, row.pr_number, row.pr_url, row.dev_build_url, row.autonomous, row.force_grill,
      row.model, row.review_model, row.extras, row.blocked_reason, row.error_message, row.resume_state, now(), now(),
    );
  },
  get(id: string): LoopRow | null {
    return db.query("SELECT * FROM loops WHERE id = ?").get(id) as LoopRow | null;
  },
  byIssue(issueId: string): LoopRow[] {
    return db.query("SELECT * FROM loops WHERE issue_id = ? ORDER BY created_at DESC").all(issueId) as LoopRow[];
  },
  activeByIssue(issueId: string): LoopRow | null {
    return db
      .query("SELECT * FROM loops WHERE issue_id = ? AND state NOT IN ('approved','exhausted','cancelled') LIMIT 1")
      .get(issueId) as LoopRow | null;
  },
  all(): LoopRow[] {
    return db.query("SELECT * FROM loops ORDER BY created_at DESC").all() as LoopRow[];
  },
  active(): LoopRow[] {
    return db
      .query("SELECT * FROM loops WHERE state IN ('queued','running','blocked','paused') ORDER BY created_at ASC")
      .all() as LoopRow[];
  },
  countRunning(): number {
    const r = db.query("SELECT COUNT(*) AS n FROM loops WHERE state = 'running'").get() as { n: number };
    return r.n;
  },
  update(id: string, patch: Partial<LoopRow>): void {
    const keys = Object.keys(patch) as Array<keyof LoopRow>;
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${String(k)} = ?`).join(", ");
    const values = keys.map((k) => patch[k] as unknown);
    db.query(`UPDATE loops SET ${sets}, updated_at = ? WHERE id = ?`).run(...(values as never[]), now(), id);
  },
};

export const threadsRepo = {
  insert(row: Omit<ThreadRow, "created_at">): void {
    db.query(
      `INSERT INTO threads (id, loop_id, issue_id, role, t3_thread_id, branch, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(row.id, row.loop_id, row.issue_id, row.role, row.t3_thread_id, row.branch, now());
  },
  forLoop(loopId: string, role?: ThreadRow["role"]): ThreadRow[] {
    return role
      ? (db.query("SELECT * FROM threads WHERE loop_id = ? AND role = ?").all(loopId, role) as ThreadRow[])
      : (db.query("SELECT * FROM threads WHERE loop_id = ?").all(loopId) as ThreadRow[]);
  },
  interactiveForIssue(issueId: string): ThreadRow | null {
    return db
      .query("SELECT * FROM threads WHERE issue_id = ? AND role = 'interactive' ORDER BY created_at DESC LIMIT 1")
      .get(issueId) as ThreadRow | null;
  },
  adopt(threadId: string, loopId: string, role: ThreadRow["role"]): void {
    db.query("UPDATE threads SET loop_id = ?, role = ? WHERE id = ?").run(loopId, role, threadId);
  },
};

export const dispatchesRepo = {
  insert(row: Omit<DispatchRow, "confirmed_at" | "settled_at" | "outcome">): void {
    db.query(
      `INSERT INTO dispatches (id, loop_id, t3_thread_id, message_id, kind, text, dispatched_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(row.id, row.loop_id, row.t3_thread_id, row.message_id, row.kind, row.text, row.dispatched_at);
  },
  confirm(id: string): void {
    db.query("UPDATE dispatches SET confirmed_at = ? WHERE id = ?").run(now(), id);
  },
  settle(id: string, outcome: string): void {
    db.query("UPDATE dispatches SET settled_at = ?, outcome = ? WHERE id = ?").run(now(), outcome, id);
  },
  delete(id: string): void {
    db.query("DELETE FROM dispatches WHERE id = ?").run(id);
  },
  unsettledForLoop(loopId: string): DispatchRow | null {
    return db
      .query("SELECT * FROM dispatches WHERE loop_id = ? AND settled_at IS NULL ORDER BY dispatched_at DESC LIMIT 1")
      .get(loopId) as DispatchRow | null;
  },
  lastSettledForLoop(loopId: string): DispatchRow | null {
    return db
      .query("SELECT * FROM dispatches WHERE loop_id = ? AND settled_at IS NOT NULL ORDER BY dispatched_at DESC LIMIT 1")
      .get(loopId) as DispatchRow | null;
  },
};

export const iterationsRepo = {
  start(loopId: string, n: number, remoteShaBefore: string | null): string {
    const id = crypto.randomUUID();
    db.query(
      `INSERT INTO iterations (id, loop_id, n, remote_sha_before, started_at) VALUES (?,?,?,?,?)
       ON CONFLICT (loop_id, n) DO NOTHING`,
    ).run(id, loopId, n, remoteShaBefore, now());
    return id;
  },
  get(loopId: string, n: number): IterationRow | null {
    return db.query("SELECT * FROM iterations WHERE loop_id = ? AND n = ?").get(loopId, n) as IterationRow | null;
  },
  forLoop(loopId: string): IterationRow[] {
    return db.query("SELECT * FROM iterations WHERE loop_id = ? ORDER BY n ASC").all(loopId) as IterationRow[];
  },
  update(loopId: string, n: number, patch: Partial<IterationRow>): void {
    const keys = Object.keys(patch) as Array<keyof IterationRow>;
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${String(k)} = ?`).join(", ");
    const values = keys.map((k) => patch[k] as unknown);
    db.query(`UPDATE iterations SET ${sets} WHERE loop_id = ? AND n = ?`).run(...(values as never[]), loopId, n);
  },
};

export const eventsRepo = {
  add(loopId: string | null, kind: string, data?: unknown): void {
    db.query("INSERT INTO events (loop_id, kind, data_json, created_at) VALUES (?,?,?,?)").run(
      loopId,
      kind,
      data === undefined ? null : JSON.stringify(data),
      now(),
    );
  },
  forLoop(loopId: string): Array<{ id: number; kind: string; data_json: string | null; created_at: string }> {
    return db.query("SELECT id, kind, data_json, created_at FROM events WHERE loop_id = ? ORDER BY id ASC").all(loopId) as never;
  },
};
