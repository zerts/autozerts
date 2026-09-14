/**
 * Read-only access to T3 Code's state.sqlite projections via bun:sqlite.
 * Replaces the Raycast extension's execFile("/usr/bin/sqlite3") approach
 * with parameterized queries against the live (WAL) database.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Database } from "bun:sqlite";

export const T3_USER_DATA = path.join(os.homedir(), ".t3", "userdata");
export const SERVER_RUNTIME_PATH = path.join(T3_USER_DATA, "server-runtime.json");
const STATE_DB_PATH = path.join(T3_USER_DATA, "state.sqlite");
const ENVIRONMENT_ID_PATH = path.join(T3_USER_DATA, "environment-id");

let db: Database | null = null;

function getDb(): Database {
  if (!db) {
    if (!fs.existsSync(STATE_DB_PATH)) {
      throw new Error("T3 Code state.sqlite not found — has T3 Code ever run?");
    }
    db = new Database(STATE_DB_PATH, { readonly: true });
  }
  return db;
}

export interface AuthSession {
  sessionId: string;
  subject: string;
  expiresAtMs: number;
}

export function readActiveSession(): AuthSession {
  const row = getDb()
    .query(
      `SELECT session_id, subject, expires_at FROM auth_sessions
       WHERE revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1`,
    )
    .get() as { session_id: string; subject: string; expires_at: string } | null;
  if (!row) throw new Error("No active T3 Code session — sign in to T3 Code first");
  const expiresAtMs = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error("T3 Code session expired — sign in to T3 Code again");
  }
  return { sessionId: row.session_id, subject: row.subject, expiresAtMs };
}

export interface T3Project {
  projectId: string;
  workspaceRoot: string;
}

export function findProjectByWorkspaceRoot(workspaceRoot: string): T3Project | null {
  const row = getDb()
    .query(
      `SELECT project_id, workspace_root FROM projection_projects
       WHERE workspace_root = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(workspaceRoot) as { project_id: string; workspace_root: string } | null;
  return row ? { projectId: row.project_id, workspaceRoot: row.workspace_root } : null;
}

export interface T3Turn {
  turnId: string | null;
  state: "pending" | "running" | "completed" | "error";
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export function turnsForThread(threadId: string, sinceIso?: string): T3Turn[] {
  const rows = getDb()
    .query(
      `SELECT turn_id, state, requested_at, started_at, completed_at
       FROM projection_turns
       WHERE thread_id = ? AND requested_at >= ?
       ORDER BY requested_at ASC`,
    )
    .all(threadId, sinceIso ?? "") as Array<{
    turn_id: string | null;
    state: T3Turn["state"];
    requested_at: string;
    started_at: string | null;
    completed_at: string | null;
  }>;
  return rows.map((r) => ({
    turnId: r.turn_id,
    state: r.state,
    requestedAt: r.requested_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  }));
}

export interface ThreadSessionStatus {
  status: "running" | "ready" | "stopped" | "error" | (string & {});
  activeTurnId: string | null;
  lastError: string | null;
  updatedAt: string;
}

/**
 * The authoritative "is the agent working" signal. projection_turns marks a
 * turn `completed` when its FIRST assistant message finishes, while the agent
 * may keep streaming under the same turn_id for minutes — only the session
 * row tracks the full agent run (status flips running → ready/stopped/error
 * when the provider session actually goes idle).
 */
export function threadSessionStatus(threadId: string): ThreadSessionStatus | null {
  const row = getDb()
    .query(
      `SELECT status, active_turn_id, last_error, updated_at
       FROM projection_thread_sessions WHERE thread_id = ? LIMIT 1`,
    )
    .get(threadId) as
    | { status: string; active_turn_id: string | null; last_error: string | null; updated_at: string }
    | null;
  if (!row) return null;
  return {
    status: row.status,
    activeTurnId: row.active_turn_id,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export function hasActiveTurns(threadId: string): boolean {
  const row = getDb()
    .query(
      `SELECT COUNT(*) AS n FROM projection_turns
       WHERE thread_id = ? AND state IN ('pending','running')`,
    )
    .get(threadId) as { n: number };
  return row.n > 0;
}

export interface T3ThreadInfo {
  threadId: string;
  projectId: string;
  title: string;
  branch: string | null;
  worktreePath: string | null;
  pendingApprovalCount: number;
  pendingUserInputCount: number;
  deletedAt: string | null;
}

export function threadInfo(threadId: string): T3ThreadInfo | null {
  const row = getDb()
    .query(
      `SELECT thread_id, project_id, title, branch, worktree_path,
              pending_approval_count, pending_user_input_count, deleted_at
       FROM projection_threads WHERE thread_id = ? LIMIT 1`,
    )
    .get(threadId) as
    | {
        thread_id: string;
        project_id: string;
        title: string;
        branch: string | null;
        worktree_path: string | null;
        pending_approval_count: number;
        pending_user_input_count: number;
        deleted_at: string | null;
      }
    | null;
  if (!row) return null;
  return {
    threadId: row.thread_id,
    projectId: row.project_id,
    title: row.title,
    branch: row.branch,
    worktreePath: row.worktree_path,
    pendingApprovalCount: row.pending_approval_count,
    pendingUserInputCount: row.pending_user_input_count,
    deletedAt: row.deleted_at,
  };
}

/** Crash-recovery check: did a journaled dispatch actually reach T3? */
export function messageExists(threadId: string, messageId: string): boolean {
  const row = getDb()
    .query(
      `SELECT COUNT(*) AS n FROM projection_thread_messages
       WHERE thread_id = ? AND message_id = ?`,
    )
    .get(threadId, messageId) as { n: number };
  return row.n > 0;
}

/** Latest user/assistant message timestamps — used to detect turn settlement for command-only turns like /compact. */
export function latestMessageAt(threadId: string): string | null {
  const row = getDb()
    .query(
      `SELECT MAX(created_at) AS latest FROM projection_thread_messages WHERE thread_id = ?`,
    )
    .get(threadId) as { latest: string | null };
  return row.latest;
}

export interface ServerRuntime {
  port: number;
  origin: string;
}

export function readServerRuntime(): ServerRuntime {
  let raw: string;
  try {
    raw = fs.readFileSync(SERVER_RUNTIME_PATH, "utf8");
  } catch {
    throw new Error("T3 Code is not running");
  }
  const parsed = JSON.parse(raw) as { port?: number; origin?: string };
  if (!parsed.port || !parsed.origin) throw new Error("T3 Code server runtime is malformed");
  return { port: parsed.port, origin: parsed.origin };
}

/**
 * T3's stable per-install environment id (persisted to `~/.t3/userdata/
 * environment-id` on first launch). It's the first path segment of a thread's
 * SPA route: `/<environmentId>/<threadId>`.
 */
export function readEnvironmentId(): string {
  let raw: string;
  try {
    raw = fs.readFileSync(ENVIRONMENT_ID_PATH, "utf8");
  } catch {
    throw new Error("T3 Code environment-id not found — has T3 Code ever run?");
  }
  const id = raw.trim();
  if (!id) throw new Error("T3 Code environment-id is empty");
  return id;
}

export interface TokenUsageWindow {
  turns: number;
  /** Cumulative input tokens (includes cache reads). */
  inputTokens: number;
  outputTokens: number;
}

export interface TokenUsage {
  today: TokenUsageWindow;
  last7Days: TokenUsageWindow;
  allTime: TokenUsageWindow;
  /** Distinct threads that recorded any token usage. */
  threads: number;
  /** ISO timestamp of the earliest recorded turn, or null when there is none. */
  since: string | null;
  generatedAt: string;
}

/**
 * Aggregate T3 Code token usage from the `context-window.updated` activities in
 * the orchestration event log. Most of those events carry only a live
 * context-window occupancy (`usedTokens`); the turn-settling ones additionally
 * carry cumulative `inputTokens`/`outputTokens` for that turn (input includes
 * cache reads). We take the max input/output per `turnId`, then sum across
 * turns — summing the raw events would multiply-count a turn's running totals.
 */
export function readTokenUsage(): TokenUsage {
  const rows = getDb()
    .query(
      `WITH cw AS (
         SELECT json_extract(payload_json,'$.activity.turnId') AS turn,
                json_extract(payload_json,'$.threadId') AS thread,
                occurred_at AS at,
                CAST(json_extract(payload_json,'$.activity.payload.inputTokens') AS INTEGER) AS inp,
                CAST(json_extract(payload_json,'$.activity.payload.outputTokens') AS INTEGER) AS out
         FROM orchestration_events
         WHERE event_type = 'thread.activity-appended'
           AND json_extract(payload_json,'$.activity.kind') = 'context-window.updated'
           AND json_extract(payload_json,'$.activity.payload.inputTokens') IS NOT NULL
       )
       SELECT turn, MAX(thread) AS thread, MAX(at) AS at,
              MAX(inp) AS inp, MAX(out) AS out
       FROM cw
       GROUP BY turn`,
    )
    .all() as Array<{ turn: string | null; thread: string | null; at: string; inp: number; out: number }>;

  const empty = (): TokenUsageWindow => ({ turns: 0, inputTokens: 0, outputTokens: 0 });
  const today = empty();
  const last7Days = empty();
  const allTime = empty();
  const threads = new Set<string>();
  let since: string | null = null;

  const now = Date.now();
  const weekAgoMs = now - 7 * 24 * 3600 * 1000;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTodayMs = startOfToday.getTime();

  const add = (w: TokenUsageWindow, inp: number, out: number) => {
    w.turns += 1;
    w.inputTokens += inp;
    w.outputTokens += out;
  };

  for (const row of rows) {
    const t = new Date(row.at).getTime();
    add(allTime, row.inp, row.out);
    if (t >= weekAgoMs) add(last7Days, row.inp, row.out);
    if (t >= startOfTodayMs) add(today, row.inp, row.out);
    if (row.thread) threads.add(row.thread);
    if (!since || row.at < since) since = row.at;
  }

  return {
    today,
    last7Days,
    allTime,
    threads: threads.size,
    since,
    generatedAt: new Date().toISOString(),
  };
}

export function t3Available(): boolean {
  try {
    readServerRuntime();
    return true;
  } catch {
    return false;
  }
}
