/**
 * The Loop engine: a tick-based reconciler. Every 3s each active Loop is
 * advanced one step if its pending dispatch settled. All intent is journaled
 * before dispatch (crash recovery), all transitions are persisted, and the
 * web UI is fed through the event bus.
 *
 * Micro-steps (loops.step) describe the next decision when nothing is in
 * flight:
 *   impl            re-dispatch the first message (only reached via retry)
 *   gate            PR Gate: wait for an open PR on the task branch
 *   qa-start        dispatch /loop-qa on the impl thread (opt-in repos only)
 *   qa-dispatch     re-dispatch /loop-qa / consume QA-RESULT.md after a retry
 *   review-start    dispatch review-first / compact-review / review
 *   review-dispatch dispatch review (after compact-review settled)
 *   fix-start       dispatch compact-impl
 *   fix-dispatch    record remote SHA + dispatch fix (or /address-review)
 *   push-gate       Push Gate: verify the fix actually advanced origin
 */
import { generateQaBranchName } from "../branch";
import { config, findRepo } from "../config";
import {
  dispatchesRepo,
  eventsRepo,
  iterationsRepo,
  loopsRepo,
  threadsRepo,
  type DispatchKind,
  type DispatchRow,
  type LoopRow,
  type LoopState,
  type ThreadRow,
} from "../db";
import { emit } from "../events";
import { fetchDevBuildUrl, openPrForBranch, prState, refreshBaseBranch, remoteHeadSha, uploadQaScreenshots } from "../github";
import { createAttachment } from "../linear";
import { log } from "../log";
import { notify } from "../notify";
import {
  dispatchExistingThreadTurn,
  dispatchNewThread,
  dispatchTurnInterrupt,
  newId,
} from "../t3/client";
import { claudeModelSelection } from "../t3/model";
import {
  findProjectByWorkspaceRoot,
  readServerRuntime,
  t3Available,
  threadInfo,
  threadSessionStatus,
} from "../t3/state";
import { checkSettlement } from "../t3/watch";
import {
  archiveQaArtifacts,
  archiveReviewDoc,
  buildPrComment,
  buildQaPrComment,
  clearQaDoc,
  clearReviewDoc,
  parseQaDoc,
  parseReviewDoc,
  QA_DOC_FILENAME,
  readQaDoc,
  readReviewDoc,
  REVIEW_DOC_FILENAME,
  type QaImageRef,
} from "./courier";
import { acquirePortLease, QA_PORT, releaseLeasesForLoop } from "./lease";
import { shouldStartTick } from "./tick-watchdog";
import {
  ADDRESS_REVIEW_MESSAGE,
  COMPACT_MESSAGE,
  firstMessage,
  fixMessage,
  nudgePushMessage,
  qaFixMessage,
  qaMessage,
  reviewMessage,
} from "./prompts";

const TICK_MS = 3_000;
const GATE_CHECK_MS = 30_000;

const lastGateCheck = new Map<string, number>();

function setLoop(loop: LoopRow, patch: Partial<LoopRow>, eventKind?: string, eventData?: unknown): LoopRow {
  loopsRepo.update(loop.id, patch);
  const updated = loopsRepo.get(loop.id)!;
  if (eventKind) eventsRepo.add(loop.id, eventKind, eventData);
  emit({ type: "loop.updated", loopId: loop.id });
  return updated;
}

function toTerminal(loop: LoopRow, state: Extract<LoopState, "approved" | "exhausted" | "cancelled" | "error">, extra: Partial<LoopRow> = {}): LoopRow {
  releaseLeasesForLoop(loop.id); // a terminal loop holds no port
  const updated = setLoop(loop, { state, terminal_at: new Date().toISOString(), ...extra }, `loop.${state}`);
  const title = `${loop.issue_identifier} — ${state}`;
  if (state === "approved") notify(title, "Review loop approved. PR is ready for human review.");
  if (state === "exhausted") notify(title, `Still needs-changes after ${loop.max_iterations} iterations.`);
  if (state === "error") notify(title, loop.error_message ?? "Loop hit an error.");
  return updated;
}

function block(loop: LoopRow, reason: string): LoopRow {
  if (loop.state === "blocked" && loop.blocked_reason === reason) return loop;
  notify(`${loop.issue_identifier} — waiting`, reason);
  return setLoop(loop, { state: "blocked", blocked_reason: reason }, "loop.blocked", { reason });
}

function unblock(loop: LoopRow): LoopRow {
  const slotFree = loopsRepo.countRunning() < config.maxParallelLoops;
  return setLoop(loop, { state: slotFree ? "running" : "queued", blocked_reason: null }, "loop.unblocked");
}

function pause(loop: LoopRow): LoopRow {
  const resumeState = loop.state === "paused" ? loop.resume_state : loop.state;
  return setLoop(loop, { state: "paused", resume_state: resumeState }, "loop.paused");
}

function isT3DownError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /not running|websocket error|closed the connection|timed out/i.test(msg);
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

function implThread(loop: LoopRow): ThreadRow | null {
  return threadsRepo.forLoop(loop.id, "implementation")[0] ?? null;
}

function reviewThread(loop: LoopRow): ThreadRow | null {
  return threadsRepo.forLoop(loop.id, "review")[0] ?? null;
}

/**
 * The QA smoke gate runs for repos that opt in, on both the initial round and
 * the address-review round — the latter so the screenshots that prove the
 * human-requested changes boot/render are attached to the loop too.
 */
function qaEnabled(loop: LoopRow): boolean {
  return !!findRepo(loop.repo_name)?.qaGate;
}

/** The dev-server port this loop's repo serves QA on (repo override, else the shared default). */
function qaPortFor(loop: LoopRow): number {
  return findRepo(loop.repo_name)?.qaPort ?? QA_PORT;
}


// ---------------------------------------------------------------------------
// Dispatch (journal → send → confirm)
// ---------------------------------------------------------------------------

interface NewThreadSpec {
  branch: string;
  baseBranch: string;
  title: string;
}

async function dispatchTurn(
  loop: LoopRow,
  thread: ThreadRow,
  kind: DispatchKind,
  text: string,
  newThread?: NewThreadSpec,
): Promise<boolean> {
  const dispatchId = newId();
  const messageId = newId();
  dispatchesRepo.insert({
    id: dispatchId,
    loop_id: loop.id,
    t3_thread_id: thread.t3_thread_id,
    message_id: messageId,
    kind,
    text,
    dispatched_at: new Date().toISOString(),
  });

  try {
    if (newThread) {
      const repo = findRepo(loop.repo_name);
      if (!repo) throw new Error(`Repo ${loop.repo_name} is not configured`);
      const project = findProjectByWorkspaceRoot(repo.localPath);
      if (!project) throw new Error(`Open ${loop.repo_name} in T3 Code once to register it`);
      // Freshen the local base ref so the worktree branches off up-to-date main,
      // not whatever the clone last happened to fetch. Only when the base is the
      // repo's default branch — review threads branch off the local task branch,
      // which has no upstream to fast-forward from. Best-effort; never blocks dispatch.
      if (newThread.baseBranch === repo.defaultBranch) {
        const res = await refreshBaseBranch(repo.localPath, newThread.baseBranch);
        if (!res.ok) {
          log.warn(`loop ${loop.issue_identifier}: could not refresh ${newThread.baseBranch} — branching off local ref (${res.detail})`);
        }
      }
      await dispatchNewThread({
        threadId: thread.t3_thread_id,
        projectId: project.projectId,
        title: newThread.title,
        branch: newThread.branch,
        baseBranch: newThread.baseBranch,
        projectCwd: repo.localPath,
        modelSelection: claudeModelSelection(
          thread.role === "review"
            ? loop.review_model ?? loop.model ?? config.claudeModel
            : loop.model ?? config.claudeModel,
        ),
        firstMessage: text,
        messageId,
      });
    } else {
      await dispatchExistingThreadTurn({ threadId: thread.t3_thread_id, text, messageId });
    }
    dispatchesRepo.confirm(dispatchId);
    eventsRepo.add(loop.id, "dispatch", { kind, threadRole: thread.role });
    emit({ type: "loop.updated", loopId: loop.id });
    return true;
  } catch (error) {
    dispatchesRepo.settle(dispatchId, "send-failed");
    if (isT3DownError(error)) {
      log.warn(`loop ${loop.issue_identifier}: T3 unavailable, pausing`, String(error));
      pause(loop);
    } else {
      log.error(`loop ${loop.issue_identifier}: dispatch failed`, String(error));
      setLoop(loop, { state: "error", error_message: String(error) }, "loop.error", { error: String(error) });
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Loop start
// ---------------------------------------------------------------------------

async function startLoop(loop: LoopRow): Promise<void> {
  const repo = findRepo(loop.repo_name);
  if (!repo) {
    toTerminal(loop, "error", { error_message: `Repo ${loop.repo_name} is not configured` });
    return;
  }

  let thread = implThread(loop);
  let isNew = false;
  if (!thread) {
    // Adopt an Interactive Open thread for this issue when one exists.
    const interactive = threadsRepo.interactiveForIssue(loop.issue_id);
    if (interactive && threadInfo(interactive.t3_thread_id)?.deletedAt == null && threadInfo(interactive.t3_thread_id)) {
      threadsRepo.adopt(interactive.id, loop.id, "implementation");
      thread = { ...interactive, loop_id: loop.id, role: "implementation" };
      eventsRepo.add(loop.id, "thread.adopted", { t3ThreadId: thread.t3_thread_id });
    } else {
      thread = {
        id: newId(),
        loop_id: loop.id,
        issue_id: loop.issue_id,
        role: "implementation",
        t3_thread_id: newId(),
        branch: loop.task_branch,
        created_at: new Date().toISOString(),
      };
      threadsRepo.insert(thread);
      isNew = true;
    }
  } else {
    isNew = threadInfo(thread.t3_thread_id) === null;
  }

  const running = setLoop(loop, { state: "running", phase: loop.phase, step: "impl" }, "loop.started");

  const ok = await dispatchTurn(
    running,
    thread,
    loop.round === "address-review" ? "address-review" : "first",
    loop.round === "address-review" ? ADDRESS_REVIEW_MESSAGE : firstMessage(loop),
    isNew
      ? {
          branch: loop.task_branch!,
          baseBranch: repo.defaultBranch,
          title: `${loop.issue_identifier}: ${loop.issue_title}`,
        }
      : undefined,
  );
  if (!ok) return;

  // Linear attachments are best-effort; the Runner DB is the source of truth.
  if (isNew) {
    try {
      const t3Port = readServerRuntime().port;
      await createAttachment({
        issueId: loop.issue_id,
        url: `http://127.0.0.1:${t3Port}/threads/${thread.t3_thread_id}`,
        title: "T3 Code thread",
        subtitle: `${loop.repo_name} · ${loop.task_branch}`,
      });
    } catch (error) {
      log.warn("Linear thread attachment failed:", String(error));
    }
    try {
      await createAttachment({
        issueId: loop.issue_id,
        url: `http://127.0.0.1:${config.port}/loops/${loop.id}`,
        title: "AI Runner loop",
        subtitle: loop.round,
      });
    } catch (error) {
      log.warn("Linear loop attachment failed:", String(error));
    }
  }
}

// ---------------------------------------------------------------------------
// Settlement handling — advance the micro-step machine
// ---------------------------------------------------------------------------

async function handleSettled(loop: LoopRow, dispatch: DispatchRow, outcome: string): Promise<void> {
  dispatchesRepo.settle(dispatch.id, outcome);
  eventsRepo.add(loop.id, "turn.settled", { kind: dispatch.kind, outcome });

  const isCompact = dispatch.kind === "compact-impl" || dispatch.kind === "compact-review";
  // A QA probe is a throwaway run against a finished loop — a turn error just
  // yields no result and the loop is restored, never errored.
  if (outcome === "error" && !isCompact && dispatch.kind !== "qa-probe") {
    setLoop(loop, { state: "error", error_message: `Turn (${dispatch.kind}) ended in error` }, "loop.error");
    notify(`${loop.issue_identifier} — error`, `${dispatch.kind} turn failed; retry from the dashboard.`);
    return;
  }
  if (outcome === "error" && isCompact) {
    log.warn(`loop ${loop.issue_identifier}: compact failed — proceeding uncompacted`);
    eventsRepo.add(loop.id, "compact.failed", { kind: dispatch.kind });
  }

  switch (dispatch.kind) {
    case "first":
      setLoop(loop, { step: "gate" });
      break;
    case "qa":
      await handleQaSettled(loop);
      break;
    case "qa-probe":
      await handleQaProbeSettled(loop);
      break;
    case "compact-review":
      setLoop(loop, { step: "review-dispatch" });
      break;
    case "review-first":
    case "review":
      await handleReviewSettled(loop);
      break;
    case "compact-impl":
      setLoop(loop, { step: "fix-dispatch" });
      break;
    case "fix":
    case "address-review":
    case "nudge-push":
      setLoop(loop, { step: "push-gate" });
      break;
    default:
      log.warn(`unexpected settled dispatch kind ${dispatch.kind}`);
  }
}

async function handleReviewSettled(loop: LoopRow): Promise<void> {
  const rThread = reviewThread(loop);
  const info = rThread ? threadInfo(rThread.t3_thread_id) : null;
  const docContent = info?.worktreePath ? readReviewDoc(info.worktreePath) : null;
  // Consume-once: even an unparseable doc is removed so a retry turn starts clean.
  if (docContent && info?.worktreePath) clearReviewDoc(info.worktreePath);
  const parsed = docContent ? parseReviewDoc(docContent) : null;

  if (!parsed) {
    const misses = eventsRepo
      .forLoop(loop.id)
      .filter((e) => e.kind === "review-doc-missing" && JSON.parse(e.data_json ?? "{}").iteration === loop.iteration).length;
    eventsRepo.add(loop.id, "review-doc-missing", { iteration: loop.iteration });
    if (misses >= 1) {
      setLoop(loop, { state: "error", error_message: `Review produced no parseable ${REVIEW_DOC_FILENAME} twice` }, "loop.error");
      notify(`${loop.issue_identifier} — error`, "Review doc missing twice; needs a human look.");
      return;
    }
    setLoop(loop, { step: "review-dispatch" }, "review.retry");
    return;
  }

  const docPath = archiveReviewDoc(loop.issue_identifier, loop.id, loop.iteration, docContent!);
  iterationsRepo.update(loop.id, loop.iteration, {
    verdict: parsed.verdict,
    findings_json: JSON.stringify(parsed.findings),
    review_doc_path: docPath,
    reviewed_at: new Date().toISOString(),
  });

  const repo = findRepo(loop.repo_name);
  if (repo && loop.pr_number) {
    try {
      await import("../github").then((gh) =>
        gh.postPrComment(repo.localPath, loop.pr_number!, buildPrComment(loop.iteration, loop.max_iterations, parsed)),
      );
    } catch (error) {
      log.warn("PR comment failed (non-fatal):", String(error));
    }
  }

  if (parsed.verdict === "approved") {
    toTerminal(loop, "approved");
    return;
  }

  if (loop.iteration >= loop.max_iterations) {
    const exhausted = toTerminal(loop, "exhausted");
    if (repo && exhausted.pr_number) {
      try {
        await import("../github").then((gh) =>
          gh.postPrComment(
            repo.localPath,
            exhausted.pr_number!,
            `## 🛑 Review loop exhausted\n\nStill \`needs-changes\` after ${loop.max_iterations} iterations — needs human attention.\n\n_Posted by ai-runner._`,
          ),
        );
      } catch (error) {
        log.warn("exhausted PR comment failed:", String(error));
      }
    }
    return;
  }

  setLoop(loop, { phase: "fixing", step: "fix-start" }, "verdict.needs-changes", { iteration: loop.iteration });
}

/**
 * The QA smoke gate result, couriered like the review doc but read from the
 * implementation thread's worktree. `pass` → review; `fail` → fixing (reusing
 * the fix machinery, the QA doc injected like a needs-changes finding).
 */
async function handleQaSettled(loop: LoopRow): Promise<void> {
  const thread = implThread(loop);
  const info = thread ? threadInfo(thread.t3_thread_id) : null;
  const worktree = info?.worktreePath ?? null;
  const docContent = worktree ? readQaDoc(worktree) : null;
  const parsed = docContent ? parseQaDoc(docContent) : null;

  if (!parsed || !worktree) {
    if (worktree) clearQaDoc(worktree); // consume-once even when unparseable
    const misses = eventsRepo
      .forLoop(loop.id)
      .filter((e) => e.kind === "qa-doc-missing" && JSON.parse(e.data_json ?? "{}").iteration === loop.iteration).length;
    eventsRepo.add(loop.id, "qa-doc-missing", { iteration: loop.iteration });
    if (misses >= 1) {
      releaseLeasesForLoop(loop.id);
      setLoop(loop, { state: "error", error_message: `QA produced no parseable ${QA_DOC_FILENAME} twice` }, "loop.error");
      notify(`${loop.issue_identifier} — error`, "QA result missing twice; needs a human look.");
      return;
    }
    setLoop(loop, { step: "qa-dispatch" }, "qa.retry");
    return;
  }

  // Archive doc + screenshots out of the worktree, then consume-once.
  const archived = archiveQaArtifacts(loop.issue_identifier, loop.id, loop.iteration, worktree, docContent!, parsed.screenshots);
  clearQaDoc(worktree);
  iterationsRepo.update(loop.id, loop.iteration, {
    qa_verdict: parsed.qa,
    qa_doc_path: archived.docPath,
    qa_screenshots_json: JSON.stringify(archived.images),
    qa_reviewed_at: new Date().toISOString(),
  });

  const repo = findRepo(loop.repo_name);
  if (repo && loop.pr_number) {
    let imageRefs: QaImageRef[] = archived.images.map((i) => ({
      name: i.path.split("/").pop()!,
      ...(i.label ? { label: i.label } : {}),
    }));
    try {
      const uploaded = await uploadQaScreenshots(repo.localPath, `${loop.issue_identifier}/${loop.id}/${loop.iteration}`, archived.images);
      if (uploaded.length > 0) {
        imageRefs = uploaded.map((u) => ({ name: u.name, ...(u.label ? { label: u.label } : {}), ...(u.url ? { url: u.url } : {}) }));
      }
    } catch (error) {
      log.warn("QA screenshot upload failed (non-fatal):", String(error));
    }
    try {
      await import("../github").then((gh) =>
        gh.postPrComment(repo.localPath, loop.pr_number!, buildQaPrComment(loop.iteration, loop.max_iterations, parsed, imageRefs)),
      );
    } catch (error) {
      log.warn("QA PR comment failed (non-fatal):", String(error));
    }
  }

  // The QA turn has settled and the skill killed its server, so the port is
  // free now whichever way we route next.
  releaseLeasesForLoop(loop.id);

  if (parsed.qa === "pass") {
    setLoop(loop, { phase: "reviewing", step: "review-start" }, "qa.passed");
    return;
  }

  // qa: fail — fix it before review, reusing the fix machinery.
  if (loop.iteration >= loop.max_iterations) {
    const exhausted = toTerminal(loop, "exhausted");
    if (repo && exhausted.pr_number) {
      try {
        await import("../github").then((gh) =>
          gh.postPrComment(
            repo.localPath,
            exhausted.pr_number!,
            `## 🛑 QA gate exhausted\n\nStill failing the QA smoke gate after ${loop.max_iterations} iterations — needs human attention.\n\n_Posted by ai-runner._`,
          ),
        );
      } catch (error) {
        log.warn("exhausted QA PR comment failed:", String(error));
      }
    }
    return;
  }
  setLoop(loop, { phase: "fixing", step: "fix-start" }, "qa.failed", { iteration: loop.iteration });
}

/**
 * A manual, one-off QA probe against a finished loop's existing PR (the "Run
 * QA" button). It reuses the gate machinery to run `/loop-qa` on the impl
 * thread and surface the verdict + screenshots, but DOES NOT continue into
 * review/fixing — when it settles, the loop is restored to the terminal state
 * it had before. Lets you exercise the QA gate against real PRs without a fresh
 * implement cycle. See autozerts-private/docs/web-app-qa-gate.md Phase F.
 */
export async function runQaProbe(loop: LoopRow): Promise<{ ok: boolean; message?: string }> {
  if (!loop.pr_number) return { ok: false, message: "This loop has no PR to QA." };
  if (loop.state !== "approved" && loop.state !== "exhausted" && loop.state !== "cancelled") {
    return { ok: false, message: "QA probe only runs on a finished loop." };
  }
  if (loopsRepo.activeByIssue(loop.issue_id)) {
    return { ok: false, message: "Another active loop exists for this task — finish it first." };
  }
  if (!t3Available()) return { ok: false, message: "T3 Code is unavailable." };

  const thread = implThread(loop);
  const info = thread ? threadInfo(thread.t3_thread_id) : null;
  if (!thread || !info?.worktreePath) {
    return { ok: false, message: "The implementation thread/worktree no longer exists — start a fresh loop to QA this change." };
  }
  if (threadSessionStatus(thread.t3_thread_id)?.status === "running") {
    return { ok: false, message: "The implementation thread is busy right now." };
  }
  const probePort = qaPortFor(loop);
  if (!acquirePortLease(probePort, loop.id)) {
    return { ok: false, message: `Port ${probePort} is busy with another QA run.` };
  }

  // Remember where to return, then make the loop briefly active so the tick
  // loop detects the dispatch's settlement through the normal journal path.
  const probeReturn = JSON.stringify({ state: loop.state, phase: loop.phase, step: loop.step, terminalAt: loop.terminal_at });
  const active = setLoop(
    loop,
    { state: "running", phase: "qa", step: "qa-start", qa_probe: probeReturn, terminal_at: null },
    "qa-probe.started",
  );
  clearQaDoc(info.worktreePath);
  const ok = await dispatchTurn(active, thread, "qa-probe", qaMessage(active));
  if (!ok) {
    releaseLeasesForLoop(loop.id);
    restoreFromProbe(loopsRepo.get(loop.id)!);
    return { ok: false, message: "Failed to dispatch the QA turn — is T3 Code reachable?" };
  }
  return { ok: true };
}

/** Restore a loop to the terminal state it held before a QA probe (or approved). */
function restoreFromProbe(loop: LoopRow): void {
  let ret: { state?: LoopState; phase?: string; step?: string | null; terminalAt?: string | null } = {};
  try {
    ret = loop.qa_probe ? JSON.parse(loop.qa_probe) : {};
  } catch {
    ret = {};
  }
  setLoop(
    loop,
    {
      state: (ret.state as LoopState) ?? "approved",
      phase: (ret.phase as LoopRow["phase"]) ?? loop.phase,
      step: (ret.step as LoopRow["step"]) ?? null,
      terminal_at: ret.terminalAt ?? new Date().toISOString(),
      qa_probe: null,
    },
    "qa-probe.restored",
  );
}

/**
 * Settle a QA probe: archive the result, post the PR comment, surface the
 * screenshots — then restore the loop to its pre-probe terminal state. Unlike
 * {@link handleQaSettled} it never advances into review or fixing.
 */
async function handleQaProbeSettled(loop: LoopRow): Promise<void> {
  releaseLeasesForLoop(loop.id);
  const thread = implThread(loop);
  const info = thread ? threadInfo(thread.t3_thread_id) : null;
  const worktree = info?.worktreePath ?? null;
  const docContent = worktree ? readQaDoc(worktree) : null;
  const parsed = docContent ? parseQaDoc(docContent) : null;

  if (parsed && worktree) {
    iterationsRepo.start(loop.id, loop.iteration, null); // ensure a row to attach QA fields to
    const archived = archiveQaArtifacts(loop.issue_identifier, loop.id, loop.iteration, worktree, docContent!, parsed.screenshots);
    clearQaDoc(worktree);
    iterationsRepo.update(loop.id, loop.iteration, {
      qa_verdict: parsed.qa,
      qa_doc_path: archived.docPath,
      qa_screenshots_json: JSON.stringify(archived.images),
      qa_reviewed_at: new Date().toISOString(),
    });

    const repo = findRepo(loop.repo_name);
    if (repo && loop.pr_number) {
      let imageRefs: QaImageRef[] = archived.images.map((i) => ({
        name: i.path.split("/").pop()!,
        ...(i.label ? { label: i.label } : {}),
      }));
      try {
        const uploaded = await uploadQaScreenshots(repo.localPath, `${loop.issue_identifier}/${loop.id}/probe-${loop.iteration}`, archived.images);
        if (uploaded.length > 0) {
          imageRefs = uploaded.map((u) => ({ name: u.name, ...(u.label ? { label: u.label } : {}), ...(u.url ? { url: u.url } : {}) }));
        }
      } catch (error) {
        log.warn("QA probe screenshot upload failed (non-fatal):", String(error));
      }
      try {
        await import("../github").then((gh) =>
          gh.postPrComment(repo.localPath, loop.pr_number!, buildQaPrComment(loop.iteration, loop.max_iterations, parsed, imageRefs)),
        );
      } catch (error) {
        log.warn("QA probe PR comment failed (non-fatal):", String(error));
      }
    }
    eventsRepo.add(loop.id, "qa-probe.completed", { verdict: parsed.qa });
    notify(`${loop.issue_identifier} — QA probe`, `QA smoke gate: ${parsed.qa}.`);
  } else {
    if (worktree) clearQaDoc(worktree);
    eventsRepo.add(loop.id, "qa-probe.no-result", {});
    notify(`${loop.issue_identifier} — QA probe`, "QA produced no parseable result.");
  }

  restoreFromProbe(loopsRepo.get(loop.id) ?? loop);
}

// ---------------------------------------------------------------------------
// Decision points — act when nothing is in flight
// ---------------------------------------------------------------------------

function gateCheckDue(loopId: string): boolean {
  const last = lastGateCheck.get(loopId) ?? 0;
  if (Date.now() - last < GATE_CHECK_MS) return false;
  lastGateCheck.set(loopId, Date.now());
  return true;
}

async function decisionPoint(loop: LoopRow): Promise<void> {
  switch (loop.step) {
    case "impl": {
      // Reached only after retry of a failed first turn.
      const thread = implThread(loop);
      if (!thread) return void (await startLoop(loop));
      const exists = threadInfo(thread.t3_thread_id);
      const repo = findRepo(loop.repo_name)!;
      const text = loop.round === "address-review" ? ADDRESS_REVIEW_MESSAGE : firstMessage(loop);
      const kind: DispatchKind = loop.round === "address-review" ? "address-review" : "first";
      await dispatchTurn(loop, thread, kind, text,
        exists ? undefined : {
          branch: loop.task_branch!,
          baseBranch: repo.defaultBranch,
          title: `${loop.issue_identifier}: ${loop.issue_title}`,
        });
      break;
    }

    case "gate":
      await checkPrGate(loop);
      break;

    case "qa-start": {
      const thread = implThread(loop);
      if (!thread) {
        setLoop(loop, { state: "error", error_message: "Implementation thread missing for QA" }, "loop.error");
        return;
      }
      // Don't interrupt the impl agent while it's working (or a human is in it).
      if (threadSessionStatus(thread.t3_thread_id)?.status === "running") return;
      // The repo's QA port is a singleton — claim the lease before serving, or wait.
      {
        const port = qaPortFor(loop);
        if (!acquirePortLease(port, loop.id)) {
          block(loop, `Waiting for port ${port} — another loop is running QA`);
          return;
        }
      }
      if (loop.state === "blocked") unblock(loop);
      const worktree = threadInfo(thread.t3_thread_id)?.worktreePath;
      if (worktree) clearQaDoc(worktree);
      await dispatchTurn(loop, thread, "qa", qaMessage(loop));
      break;
    }

    case "qa-dispatch": {
      const thread = implThread(loop);
      if (!thread) {
        setLoop(loop, { step: "qa-start" });
        return;
      }
      if (threadSessionStatus(thread.t3_thread_id)?.status === "running") return;
      const worktree = threadInfo(thread.t3_thread_id)?.worktreePath;
      if (worktree && readQaDoc(worktree) !== null) {
        await handleQaSettled(loop);
        return;
      }
      // Still holding the lease from qa-start (we only release on leaving QA);
      // re-take it defensively in case a stale-reclaim handed it elsewhere.
      {
        const port = qaPortFor(loop);
        if (!acquirePortLease(port, loop.id)) {
          block(loop, `Waiting for port ${port} — another loop is running QA`);
          return;
        }
      }
      await dispatchTurn(loop, thread, "qa", qaMessage(loop));
      break;
    }

    case "review-start": {
      if (loop.state === "blocked") return;
      const repo = findRepo(loop.repo_name)!;
      // A PR closed/merged externally ends the loop.
      if (loop.pr_number && gateCheckDue(`${loop.id}:prstate`)) {
        try {
          const state = await prState(repo.localPath, loop.pr_number);
          if (state !== "OPEN") {
            toTerminal(loop, "cancelled", { error_message: `PR #${loop.pr_number} ${state.toLowerCase()} externally` });
            return;
          }
        } catch (error) {
          log.warn("prState check failed:", String(error));
        }
      }
      let rThread = reviewThread(loop);
      if (!rThread || threadInfo(rThread.t3_thread_id) === null) {
        if (!rThread) {
          rThread = {
            id: newId(),
            loop_id: loop.id,
            issue_id: loop.issue_id,
            role: "review",
            t3_thread_id: newId(),
            branch: generateQaBranchName(loop.task_branch!),
            created_at: new Date().toISOString(),
          };
          threadsRepo.insert(rThread);
        }
        await dispatchTurn(loop, rThread, "review-first", reviewMessage(loop), {
          branch: rThread.branch!,
          baseBranch: loop.task_branch!,
          title: `${loop.issue_identifier}: review loop`,
        });
      } else {
        // Never interrupt a review agent that is still working (a human may
        // also be conversing with the thread directly).
        if (threadSessionStatus(rThread.t3_thread_id)?.status === "running") return;
        const worktree = threadInfo(rThread.t3_thread_id)?.worktreePath;
        if (worktree) clearReviewDoc(worktree);
        if (loop.iteration >= 2) {
          await dispatchTurn(loop, rThread, "compact-review", COMPACT_MESSAGE);
        } else {
          await dispatchTurn(loop, rThread, "review", reviewMessage(loop));
        }
      }
      break;
    }

    case "review-dispatch": {
      const rThread = reviewThread(loop);
      if (!rThread) {
        setLoop(loop, { step: "review-start" });
        return;
      }
      // A review agent may still be running here — e.g. the loop was revived
      // via retry after a falsely-settled turn. Wait for it instead of
      // interrupting, then consume the doc it leaves behind.
      if (threadSessionStatus(rThread.t3_thread_id)?.status === "running") return;
      const worktree = threadInfo(rThread.t3_thread_id)?.worktreePath;
      if (worktree && readReviewDoc(worktree) !== null) {
        await handleReviewSettled(loop);
        return;
      }
      await dispatchTurn(loop, rThread, "review", reviewMessage(loop));
      break;
    }

    case "fix-start": {
      const thread = implThread(loop);
      if (!thread) {
        setLoop(loop, { state: "error", error_message: "Implementation thread missing" }, "loop.error");
        return;
      }
      iterationsRepo.start(loop.id, loop.iteration, null);
      await dispatchTurn(loop, thread, "compact-impl", COMPACT_MESSAGE);
      break;
    }

    case "fix-dispatch": {
      const thread = implThread(loop)!;
      const repo = findRepo(loop.repo_name)!;
      let shaBefore: string | null = null;
      try {
        shaBefore = await remoteHeadSha(repo.localPath, loop.task_branch!);
      } catch (error) {
        log.warn("remoteHeadSha failed:", String(error));
      }
      iterationsRepo.start(loop.id, loop.iteration, shaBefore);
      iterationsRepo.update(loop.id, loop.iteration, { remote_sha_before: shaBefore });

      const isFirstArTurn =
        loop.round === "address-review" &&
        !dispatchesRepo.lastSettledForLoop(loop.id)?.kind.match(/^(fix|address-review|nudge-push)$/);
      if (isFirstArTurn) {
        await dispatchTurn(loop, thread, "address-review", ADDRESS_REVIEW_MESSAGE);
      } else {
        const iteration = iterationsRepo.get(loop.id, loop.iteration);
        if (iteration?.review_doc_path) {
          const doc = await Bun.file(iteration.review_doc_path).text().catch(() => null);
          await dispatchTurn(loop, thread, "fix", fixMessage(loop, doc ?? "(review doc unavailable — re-read the latest loop review comment on the PR)"));
        } else if (iteration?.qa_verdict === "fail" && iteration.qa_doc_path) {
          // This iteration is fixing a QA-gate failure (review hasn't run yet).
          const doc = await Bun.file(iteration.qa_doc_path).text().catch(() => null);
          await dispatchTurn(loop, thread, "fix", qaFixMessage(loop, doc ?? "(QA result unavailable — re-read the latest QA comment on the PR)", qaPortFor(loop)));
        } else {
          await dispatchTurn(loop, thread, "fix", fixMessage(loop, "(review doc unavailable — re-read the latest loop review comment on the PR)"));
        }
      }
      break;
    }

    case "push-gate":
      await checkPushGate(loop);
      break;

    default:
      log.warn(`loop ${loop.issue_identifier}: no decision for step=${loop.step}`);
  }
}

async function checkPrGate(loop: LoopRow): Promise<void> {
  if (!gateCheckDue(loop.id) && loop.state === "blocked") return;
  const repo = findRepo(loop.repo_name)!;

  let pr = null;
  try {
    pr = await openPrForBranch(repo.localPath, loop.task_branch!);
  } catch (error) {
    log.warn("PR gate check failed:", String(error));
    return;
  }

  if (pr) {
    const target = qaEnabled(loop)
      ? { phase: "qa" as const, step: "qa-start" as const }
      : { phase: "reviewing" as const, step: "review-start" as const };
    let next = setLoop(loop, { pr_number: pr.number, pr_url: pr.url, ...target, blocked_reason: null }, "gate.passed", { pr: pr.number });
    if (next.state === "blocked") next = unblock(next);
    iterationsRepo.start(loop.id, loop.iteration, null);
    return;
  }

  // No PR yet. If the thread is waiting on the human (grill questions,
  // approvals), surface as blocked; the human converses directly in T3.
  const thread = implThread(loop);
  const info = thread ? threadInfo(thread.t3_thread_id) : null;
  const reason =
    info && (info.pendingApprovalCount > 0 || info.pendingUserInputCount > 0)
      ? "Waiting for you in T3 Code — the thread has a question or approval to answer"
      : "In progress — waiting for a PR. Reply in T3 Code or push your branch to continue";
  block(loop, reason);
}

/**
 * Once a PR exists, CI eventually posts a "deployed to domain <url>" comment.
 * The link is stable, so we poll (throttled) only until we capture it, then
 * store it and surface it on the Linear card. Never re-checked after that.
 */
async function captureDevBuildLink(loop: LoopRow): Promise<void> {
  if (!loop.pr_number || loop.dev_build_url) return;
  if (!gateCheckDue(`${loop.id}:devbuild`)) return;
  const repo = findRepo(loop.repo_name)!;

  let url: string | null = null;
  try {
    url = await fetchDevBuildUrl(repo.localPath, loop.pr_number);
  } catch (error) {
    log.warn("dev build link check failed:", String(error));
    return;
  }
  if (!url) return;

  setLoop(loop, { dev_build_url: url }, "devbuild.captured", { url });
  try {
    await createAttachment({
      issueId: loop.issue_id,
      url,
      title: "Dev build",
      subtitle: `PR #${loop.pr_number}`,
    });
  } catch (error) {
    log.warn("Linear dev build attachment failed:", String(error));
  }
}

async function checkPushGate(loop: LoopRow): Promise<void> {
  if (loop.state === "blocked" && !gateCheckDue(loop.id)) return;
  const repo = findRepo(loop.repo_name)!;
  const iteration = iterationsRepo.get(loop.id, loop.iteration);

  let shaNow: string | null = null;
  try {
    shaNow = await remoteHeadSha(repo.localPath, loop.task_branch!);
  } catch (error) {
    log.warn("push gate check failed:", String(error));
    return;
  }

  const advanced = shaNow !== null && shaNow !== iteration?.remote_sha_before;
  if (advanced) {
    iterationsRepo.update(loop.id, loop.iteration, { remote_sha_after: shaNow });
    // Increment only when the current iteration was already verified. An
    // address-review round starts in `fixing` at iteration 1, so the push that
    // lands its *first* fix would otherwise bump the counter to 2 before the
    // round's first review — making its sole review read "2/5". The first
    // attempt hasn't been reviewed/QA'd yet, so keep its number; subsequent
    // fix→push cycles (current iteration already has a verdict) advance it.
    const verified = iteration?.reviewed_at != null || iteration?.qa_verdict != null;
    const nextN = verified ? loop.iteration + 1 : loop.iteration;
    const target = qaEnabled(loop)
      ? { phase: "qa" as const, step: "qa-start" as const }
      : { phase: "reviewing" as const, step: "review-start" as const };
    let next = setLoop(loop, { iteration: nextN, ...target, blocked_reason: null }, "push-gate.passed");
    if (next.state === "blocked") unblock(next);
    iterationsRepo.start(loop.id, nextN, null);
    return;
  }

  const last = dispatchesRepo.lastSettledForLoop(loop.id);
  if (last?.kind === "address-review") {
    // /address-review may legitimately change nothing (replies only) —
    // proceed to verification instead of nudging.
    eventsRepo.add(loop.id, "push-gate.skipped", { reason: "address-review with no push" });
    // Same rule as the advanced branch: don't bump past an unverified attempt.
    const verified = iteration?.reviewed_at != null || iteration?.qa_verdict != null;
    const nextN = verified ? loop.iteration + 1 : loop.iteration;
    const target = qaEnabled(loop)
      ? { phase: "qa" as const, step: "qa-start" as const }
      : { phase: "reviewing" as const, step: "review-start" as const };
    setLoop(loop, { iteration: nextN, ...target });
    iterationsRepo.start(loop.id, nextN, null);
    return;
  }
  if (last?.kind === "fix") {
    const thread = implThread(loop)!;
    await dispatchTurn(loop, thread, "nudge-push", nudgePushMessage(loop));
    return;
  }
  // nudge already settled and still nothing pushed
  block(loop, "In progress — the fix turn didn't push yet. Push manually or continue in T3 Code");
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

// Tick re-entrancy is guarded by a generation token rather than a bare boolean.
// A single hung await (e.g. a `gh` call frozen across a sleep/wake) must not
// deadlock the engine forever: if the lock has been held past the watchdog
// bound the next fire abandons that run and takes over. The stale run's
// `finally` then sees it no longer owns the lock and leaves the new one alone.
let activeTickRun = 0;
let tickRunSeq = 0;
let tickStartedAt = 0;

async function tickLoop(loop: LoopRow, t3Up: boolean): Promise<void> {
  if (loop.state === "paused") {
    if (t3Up) setLoop(loop, { state: (loop.resume_state as LoopState) ?? "running", resume_state: null }, "loop.resumed");
    return;
  }
  if (!t3Up && (loop.state === "running" || loop.state === "queued")) {
    if (loop.state === "running") pause(loop);
    return;
  }

  if (loop.state === "queued") {
    if (loopsRepo.countRunning() >= config.maxParallelLoops) return;
    if (loop.step === null) await startLoop(loop);
    else setLoop(loop, { state: "running" }, "loop.resumed-from-queue");
    return;
  }

  if (loop.state !== "running" && loop.state !== "blocked") return;

  const pending = dispatchesRepo.unsettledForLoop(loop.id);
  if (pending) {
    if (!pending.confirmed_at) {
      // Crash between journal and send, or send-in-flight — verify against T3.
      const { messageExists } = await import("../t3/state");
      if (messageExists(pending.t3_thread_id, pending.message_id)) dispatchesRepo.confirm(pending.id);
      else if (Date.now() - new Date(pending.dispatched_at).getTime() > 60_000) {
        dispatchesRepo.settle(pending.id, "send-failed");
      }
      return;
    }
    const settlement = checkSettlement(pending.t3_thread_id, pending.dispatched_at, pending.message_id);
    if (settlement) await handleSettled(loop, pending, settlement.outcome);
    return;
  }

  await captureDevBuildLink(loop);
  await decisionPoint(loop);
}

export async function tickAll(): Promise<void> {
  const heldMs = activeTickRun === 0 ? 0 : Date.now() - tickStartedAt;
  if (!shouldStartTick(activeTickRun !== 0, heldMs)) return;
  if (activeTickRun !== 0) {
    log.warn(
      `tick watchdog: previous tick held the lock for ${Math.round(heldMs / 1000)}s — ` +
        `abandoning it and starting a fresh tick (likely a hung subprocess or post-sleep stall)`,
    );
  }
  const myRun = ++tickRunSeq;
  activeTickRun = myRun;
  tickStartedAt = Date.now();
  try {
    const t3Up = t3Available();
    for (const loop of loopsRepo.active()) {
      try {
        await tickLoop(loop, t3Up);
      } catch (error) {
        log.error(`tick failed for loop ${loop.issue_identifier}:`, String(error));
      }
    }
  } finally {
    // Only release if a watchdog hasn't already superseded this run; otherwise a
    // late-resolving stale tick would clear the live run's lock.
    if (activeTickRun === myRun) activeTickRun = 0;
  }
}

export function startEngine(): void {
  reconcileOnStartup();
  setInterval(() => void tickAll(), TICK_MS);
  log.info("loop engine started (tick 3s)");
}

function reconcileOnStartup(): void {
  const { messageExists } = require("../t3/state") as typeof import("../t3/state");
  for (const loop of loopsRepo.active()) {
    const pending = dispatchesRepo.unsettledForLoop(loop.id);
    if (pending && !pending.confirmed_at) {
      try {
        if (messageExists(pending.t3_thread_id, pending.message_id)) {
          dispatchesRepo.confirm(pending.id);
          log.info(`reconciled dispatch ${pending.id} (confirmed via T3 message log)`);
        } else {
          dispatchesRepo.settle(pending.id, "send-failed");
          log.info(`reconciled dispatch ${pending.id} (never reached T3 — will re-dispatch)`);
        }
      } catch (error) {
        log.warn("startup reconciliation failed:", String(error));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public operations (used by the API layer)
// ---------------------------------------------------------------------------

export async function cancelLoop(loop: LoopRow): Promise<LoopRow> {
  for (const thread of threadsRepo.forLoop(loop.id)) {
    try {
      await dispatchTurnInterrupt(thread.t3_thread_id);
    } catch {
      // best-effort: thread may be idle or T3 down
    }
  }
  const pending = dispatchesRepo.unsettledForLoop(loop.id);
  if (pending) dispatchesRepo.settle(pending.id, "cancelled");
  return toTerminal(loop, "cancelled");
}

export function retryLoop(loop: LoopRow): LoopRow {
  if (loop.state !== "error") return loop;
  return setLoop(loop, { state: "running", error_message: null }, "loop.retry");
}

export function oneMoreRound(loop: LoopRow): LoopRow {
  if (loop.state !== "exhausted") return loop;
  return setLoop(
    loop,
    {
      state: "running",
      phase: "fixing",
      step: "fix-start",
      max_iterations: loop.max_iterations + 1,
      terminal_at: null,
    },
    "loop.one-more-round",
  );
}
