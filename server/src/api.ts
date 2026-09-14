/**
 * HTTP API. The Select decision tree (POST /api/tasks/:ref/select) lives only
 * here — UI and Raycast are both thin callers that render the returned action.
 */
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { taskBranchFromIssue } from "./branch";
import { config, expandHome, findRepo, repoIconUrl, saveDefaultModel, saveRepos } from "./config";
import { resolveDataPath } from "./data-paths";
import {
  dispatchesRepo,
  eventsRepo,
  iterationsRepo,
  loopsRepo,
  threadsRepo,
  type LoopRow,
} from "./db";
import { cancelLoop, oneMoreRound, retryLoop, runQaProbe } from "./engine/engine";
import { firstMessage } from "./engine/prompts";
import { onEvent } from "./events";
import { allReviewThreads, ghAuthOk, githubWebBase, prState, prStatus, refreshBaseBranch, unresolvedReviewThreads, type PrStatus, type ReviewThread } from "./github";
import {
  createAttachment,
  findDefaultRepo,
  findRepoForIssue,
  getIssue,
  listMyIssues,
  parseIssueRef,
  titlePrefixForRepo,
  type LinearIssue,
} from "./linear";
import { log } from "./log";
import { qaRepoCheckout, qaRepoStatus } from "./qa-repo";
import { dispatchNewThread, issuePairingToken, newId, openT3CodeApp } from "./t3/client";
import { CLAUDE_MODELS, claudeModelSelection } from "./t3/model";
import { readRateLimits } from "./t3/rate-limits";
import { findProjectByWorkspaceRoot, readEnvironmentId, readServerRuntime, readTokenUsage, t3Available } from "./t3/state";

export const app = new Hono();

app.onError((error, c) => {
  const message = error instanceof Error ? error.message : String(error);
  log.error(`${c.req.method} ${c.req.path}:`, message);
  const isClientError = /Not a Linear issue|Unknown repo|required/.test(message);
  return c.json({ error: message }, isClientError ? 400 : 500);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function t3Origin(): string {
  try {
    return readServerRuntime().origin;
  } catch {
    // T3 down — use the default origin for the deep link
    return "http://127.0.0.1:3773";
  }
}

function t3ThreadUrl(threadId: string): string {
  try {
    return `${t3Origin()}/${readEnvironmentId()}/${threadId}`;
  } catch {
    // environment-id unreadable — fall back to a best-effort path
    return `${t3Origin()}/threads/${threadId}`;
  }
}

/**
 * The browser pairing URL T3 itself opens on startup (`issueStartupPairingUrl`):
 * `/pair#token=<credential>`. The SPA's pairing route auto-redeems the token in
 * the fragment (sets the session cookie) and lands on the app home. We must hit
 * `/pair` directly — deep paths like `/threads/<id>` are gated and bounce to
 * `/pair` with the fragment stripped, which drops the token.
 */
function t3PairingUrl(credential: string): string {
  const url = new URL(t3Origin());
  url.pathname = "/pair";
  url.hash = new URLSearchParams([["token", credential]]).toString();
  return url.toString();
}

/**
 * A runner-hosted link that mints a fresh one-time pairing token and redirects
 * into T3, so the thread opens without the token gate. Use this for clickable
 * UI links; `t3ThreadUrl` stays the durable, token-free URL (e.g. for the
 * Linear attachment).
 */
function t3ThreadOpenUrl(threadId: string): string {
  return `http://127.0.0.1:${config.port}/api/t3/threads/${threadId}/open`;
}

function toApiLoop(loop: LoopRow) {
  const threads = threadsRepo.forLoop(loop.id);
  const impl = threads.find((t) => t.role === "implementation");
  const review = threads.find((t) => t.role === "review");
  const repo = findRepo(loop.repo_name);
  return {
    id: loop.id,
    issue: {
      id: loop.issue_id,
      identifier: loop.issue_identifier,
      title: loop.issue_title,
      url: loop.issue_url,
    },
    repo: loop.repo_name,
    iconUrl: repoIconUrl(repo),
    /** Configured project accent color, or null → UI derives one from the icon. */
    gradient: repo?.gradient ?? null,
    titlePrefix: titlePrefixForRepo(loop.issue_title, repo),
    state: loop.state,
    phase: loop.phase,
    step: loop.step,
    round: loop.round,
    iteration: loop.iteration,
    maxIterations: loop.max_iterations,
    taskBranch: loop.task_branch,
    pr: loop.pr_number ? { number: loop.pr_number, url: loop.pr_url } : null,
    devBuildUrl: loop.dev_build_url,
    autonomous: Boolean(loop.autonomous),
    forceGrill: Boolean(loop.force_grill),
    /** Whether the QA smoke gate is enabled for this loop's repo. */
    qaGate: Boolean(repo?.qaGate),
    /** Whether this loop's repo has a QA Companion Repo configured (shows the QA-build control). */
    qaCompanion: Boolean(repo?.qaCompanionPath),
    /** Shared staging deploy URL for this loop's repo, or null when none is configured. */
    stagingUrl: repo?.stagingUrl ?? null,
    model: loop.model,
    reviewModel: loop.review_model,
    blockedReason: loop.blocked_reason,
    errorMessage: loop.error_message,
    threads: {
      implementation: impl
        ? { t3ThreadId: impl.t3_thread_id, url: t3ThreadUrl(impl.t3_thread_id), openUrl: t3ThreadOpenUrl(impl.t3_thread_id) }
        : null,
      review: review
        ? { t3ThreadId: review.t3_thread_id, url: t3ThreadUrl(review.t3_thread_id), openUrl: t3ThreadOpenUrl(review.t3_thread_id) }
        : null,
    },
    createdAt: loop.created_at,
    updatedAt: loop.updated_at,
    terminalAt: loop.terminal_at,
  };
}

interface SelectBody {
  repo?: string;
  extras?: string;
  autonomous?: boolean;
  forceGrill?: boolean;
  /** T3 Claude slug for implementation; null/absent → config default. */
  model?: string;
  /** T3 Claude slug for review; null/absent → reuse `model`. */
  reviewModel?: string;
}

function createLoop(issue: LinearIssue, body: SelectBody, round: "initial" | "address-review", base?: LoopRow): LoopRow {
  const repo = body.repo
    ? findRepo(body.repo)
    : findRepo(base?.repo_name ?? "") ?? findDefaultRepo(issue.title, issue.labels.nodes.map((l) => l.name));
  if (!repo) throw new Error(`Unknown repo${body.repo ? ` ${body.repo}` : ""} — configure REPOS`);

  const id = newId();
  loopsRepo.insert({
    id,
    issue_id: issue.id,
    issue_identifier: issue.identifier,
    issue_title: issue.title,
    issue_url: issue.url,
    repo_name: repo.name,
    state: "queued",
    phase: round === "address-review" ? "fixing" : "implementing",
    step: round === "address-review" ? "fix-start" : null,
    round,
    iteration: 1,
    max_iterations: config.maxIterations,
    task_branch: base?.task_branch ?? taskBranchFromIssue(issue.branchName),
    pr_number: base?.pr_number ?? null,
    pr_url: base?.pr_url ?? null,
    dev_build_url: base?.dev_build_url ?? null,
    autonomous: body.autonomous ? 1 : 0,
    force_grill: body.forceGrill ? 1 : 0,
    model: body.model ?? base?.model ?? null,
    review_model: body.reviewModel ?? base?.review_model ?? null,
    extras: body.extras ?? null,
    blocked_reason: null,
    error_message: null,
    resume_state: null,
  });

  if (base) {
    // Address-Review Round adopts the prior round's threads.
    for (const thread of threadsRepo.forLoop(base.id)) {
      if (thread.role === "interactive") continue;
      threadsRepo.insert({
        id: newId(),
        loop_id: id,
        issue_id: thread.issue_id,
        role: thread.role,
        t3_thread_id: thread.t3_thread_id,
        branch: thread.branch,
      });
    }
  }
  eventsRepo.add(id, "loop.created", { round });
  return loopsRepo.get(id)!;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/api/health", async (c) =>
  c.json({
    status: "ok",
    version: "0.1.0",
    port: config.port,
    t3: t3Available() ? "up" : "down",
    gh: (await ghAuthOk()) ? "ok" : "unauthenticated",
    linearConfigured: Boolean(config.linearApiKey),
    repos: config.repos.map((r) => r.name),
    // Per-repo quick links for the dashboard: project icon + the GitHub pull
    // requests page, derived from each configured repo's git remote.
    repoLinks: await Promise.all(
      config.repos.map(async (r) => {
        const base = await githubWebBase(r.localPath);
        // The tokens that route issues to this repo — explicit Linear labels plus
        // issue-title prefixes (a prefix "doubles as a label"). Deduped
        // case-insensitively, first spelling wins.
        const seen = new Set<string>();
        const labels = [...(r.labels ?? []), ...(r.issuePrefixes ?? [])].filter((t) => {
          const key = t.toLowerCase();
          return seen.has(key) ? false : (seen.add(key), true);
        });
        return { name: r.name, iconUrl: repoIconUrl(r), prsUrl: base ? `${base}/pulls` : null, labels };
      }),
    ),
    models: CLAUDE_MODELS,
    defaultModel: config.claudeModel,
  }),
);

// View of the runner's configuration for the Config page. The repos array is
// editable (persisted to config.json via PUT below); everything else is a
// read-only env value. The Linear API key is never sent — only whether one is
// present.
function configView() {
  return {
    port: config.port,
    linearConfigured: Boolean(config.linearApiKey),
    dataDir: config.dataDir,
    logFile: config.logFile,
    maxParallelLoops: config.maxParallelLoops,
    maxIterations: config.maxIterations,
    defaultModel: config.claudeModel,
    models: CLAUDE_MODELS,
    repos: config.repos.map((r) => ({
      name: r.name,
      localPath: r.localPath,
      defaultBranch: r.defaultBranch,
      // Raw editable matching rules. An empty `labels` falls back to
      // `issuePrefixes` at match time (the editor shows that hint).
      issuePrefixes: r.issuePrefixes ?? [],
      labels: r.labels ?? [],
      icon: r.icon ?? "",
      iconUrl: repoIconUrl(r),
      gradient: r.gradient ?? "",
      qaGate: r.qaGate ?? false,
      qaPort: r.qaPort ?? null,
      qaCompanionPath: r.qaCompanionPath ?? "",
      stagingUrl: r.stagingUrl ?? "",
    })),
  };
}

app.get("/api/config", (c) => c.json(configView()));

// Persist edited repos to config.json and hot-apply them (no daemon restart).
// Validation failures come back as 400 with a user-facing message.
app.put("/api/config/repos", async (c) => {
  let body: { repos?: unknown };
  try {
    body = (await c.req.json()) as { repos?: unknown };
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  try {
    saveRepos(body.repos);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "invalid repos" }, 400);
  }
  return c.json(configView());
});

// Persist the config-default Claude model and hot-apply it (no daemon restart).
// Only ids from the curated CLAUDE_MODELS list are accepted.
app.put("/api/config/default-model", async (c) => {
  let body: { model?: unknown };
  try {
    body = (await c.req.json()) as { model?: unknown };
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.model !== "string" || !CLAUDE_MODELS.some((m) => m.id === body.model)) {
    return c.json({ error: "unknown model" }, 400);
  }
  saveDefaultModel(body.model);
  return c.json(configView());
});

// Serve a repo's configured project icon: an http(s) URL is redirected, a local
// file path is streamed. Cached hard — dev-build icons rarely change.
app.get("/api/repos/:name/icon", (c) => {
  const repo = findRepo(c.req.param("name"));
  if (!repo?.icon) return c.json({ error: "no icon configured" }, 404);
  if (/^https?:\/\//i.test(repo.icon)) return c.redirect(repo.icon);
  const filePath = expandHome(repo.icon);
  if (!fs.existsSync(filePath)) return c.json({ error: "icon file not found" }, 404);
  return new Response(Bun.file(filePath), {
    headers: { "Cache-Control": "public, max-age=86400" },
  });
});

app.get("/api/issues", async (c) => {
  const issues = await listMyIssues();
  return c.json(
    issues.map((issue) => {
      const loops = loopsRepo.byIssue(issue.id);
      const labels = issue.labels.nodes.map((l) => l.name);
      const projectRepo = findRepoForIssue(issue.title, labels);
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        state: issue.state,
        priority: issue.priority,
        priorityLabel: issue.priorityLabel,
        labels,
        labelDetails: issue.labels.nodes.map((l) => ({ name: l.name, color: l.color })),
        updatedAt: issue.updatedAt,
        defaultRepo: findDefaultRepo(issue.title, labels)?.name ?? null,
        iconUrl: repoIconUrl(projectRepo),
        gradient: projectRepo?.gradient ?? null,
        titlePrefix: titlePrefixForRepo(issue.title, projectRepo),
        loop: loops[0] ? toApiLoop(loops[0]) : null,
      };
    }),
  );
});

app.post("/api/tasks/:ref/select", async (c) => {
  const ref = c.req.param("ref");
  const body = (await c.req.json().catch(() => ({}))) as SelectBody;
  const issue = await getIssue(parseIssueRef(ref));

  const active = loopsRepo.activeByIssue(issue.id);
  if (active) {
    return c.json({ action: "focused", loop: toApiLoop(active) });
  }

  const previous = loopsRepo.byIssue(issue.id)[0] ?? null;
  if (previous && (previous.state === "approved" || previous.state === "exhausted") && previous.pr_number) {
    const repo = findRepo(previous.repo_name);
    let prOpen = false;
    try {
      prOpen = repo ? (await prState(repo.localPath, previous.pr_number)) === "OPEN" : false;
    } catch (error) {
      log.warn("select: prState failed:", String(error));
    }
    if (prOpen) {
      // Don't start the Address-Review Round yet — surface the unresolved
      // human threads so the caller can confirm via POST .../address-review.
      let threads: ReviewThread[] = [];
      try {
        threads = await unresolvedReviewThreads(repo!.localPath, previous.pr_number);
      } catch (error) {
        log.warn("select: review threads fetch failed:", String(error));
      }
      return c.json({ action: "address-review-available", loop: toApiLoop(previous), unresolvedThreads: threads });
    }
    return c.json({ action: "done", loop: toApiLoop(previous), message: "PR is merged/closed — nothing to do" });
  }

  const loop = createLoop(issue, body, "initial");
  return c.json({ action: "loop-started", loop: toApiLoop(loop) });
});

/** Confirmed entry into an Address-Review Round (the dialog's "start" button). */
app.post("/api/tasks/:ref/address-review", async (c) => {
  const ref = c.req.param("ref");
  const body = (await c.req.json().catch(() => ({}))) as SelectBody;
  const issue = await getIssue(parseIssueRef(ref));

  const active = loopsRepo.activeByIssue(issue.id);
  if (active) return c.json({ action: "focused", loop: toApiLoop(active) });

  const previous = loopsRepo.byIssue(issue.id)[0] ?? null;
  if (!previous || (previous.state !== "approved" && previous.state !== "exhausted") || !previous.pr_number) {
    return c.json({ error: "No finished loop with a PR for this issue" }, 409);
  }
  const repo = findRepo(previous.repo_name);
  let prOpen = false;
  try {
    prOpen = repo ? (await prState(repo.localPath, previous.pr_number)) === "OPEN" : false;
  } catch (error) {
    log.warn("address-review: prState failed:", String(error));
  }
  if (!prOpen) {
    return c.json({ action: "done", loop: toApiLoop(previous), message: "PR is merged/closed — nothing to do" });
  }

  const loop = createLoop(issue, body, "address-review", previous);
  return c.json({ action: "address-review-started", loop: toApiLoop(loop) });
});

/** Interactive Open — plain T3 thread, no Loop (today's Raycast behavior). */
app.post("/api/threads", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as SelectBody & { issueRef?: string };
  if (!body.issueRef) return c.json({ error: "issueRef required" }, 400);
  const issue = await getIssue(parseIssueRef(body.issueRef));

  const repo =
    (body.repo ? findRepo(body.repo) : findDefaultRepo(issue.title, issue.labels.nodes.map((l) => l.name))) ??
    config.repos[0];
  if (!repo) return c.json({ error: "no repos configured" }, 400);
  const project = findProjectByWorkspaceRoot(repo.localPath);
  if (!project) return c.json({ error: `Open ${repo.name} in T3 Code once to register it` }, 409);

  const branch = taskBranchFromIssue(issue.branchName);
  const t3ThreadId = newId();
  const messageId = newId();
  const skill = body.forceGrill ? "/grill-with-docs" : "/linear-implement";
  const text = `${skill} ${issue.url}${body.extras ? `\n\n${body.extras}` : ""}`;

  const dispatchId = newId();
  dispatchesRepo.insert({
    id: dispatchId,
    loop_id: null,
    t3_thread_id: t3ThreadId,
    message_id: messageId,
    kind: "interactive",
    text,
    dispatched_at: new Date().toISOString(),
  });
  // Branch the worktree off up-to-date main, not a stale local ref. Best-effort.
  {
    const res = await refreshBaseBranch(repo.localPath, repo.defaultBranch);
    if (!res.ok) log.warn(`interactive ${issue.identifier}: could not refresh ${repo.defaultBranch} (${res.detail})`);
  }
  await dispatchNewThread({
    threadId: t3ThreadId,
    projectId: project.projectId,
    title: `${issue.identifier}: ${issue.title}`,
    branch,
    baseBranch: repo.defaultBranch,
    projectCwd: repo.localPath,
    modelSelection: claudeModelSelection(body.model ?? config.claudeModel),
    firstMessage: text,
    messageId,
  });
  dispatchesRepo.confirm(dispatchId);
  dispatchesRepo.settle(dispatchId, "untracked");

  threadsRepo.insert({
    id: newId(),
    loop_id: null,
    issue_id: issue.id,
    role: "interactive",
    t3_thread_id: t3ThreadId,
    branch,
  });

  try {
    await createAttachment({
      issueId: issue.id,
      url: t3ThreadUrl(t3ThreadId),
      title: "T3 Code thread",
      subtitle: `${repo.name} · ${branch}`,
    });
  } catch (error) {
    log.warn("Linear attachment failed:", String(error));
  }

  openT3CodeApp();
  return c.json({ action: "thread-opened", t3ThreadId, url: t3ThreadUrl(t3ThreadId) });
});

/**
 * Open a T3 thread in the browser, landing directly on the thread with no token
 * gate. The runner mints a one-time pairing credential, redeems it server-side
 * against T3's `POST /api/auth/browser-session`, and forwards the resulting
 * `Set-Cookie` on its own 302 to the thread route (`/<envId>/<threadId>`). The
 * session cookie is host-only for `127.0.0.1` (no Domain attribute) and cookies
 * ignore port, so a cookie set on the runner's `:4777` response is sent to T3's
 * `:3773` — the browser arrives already authenticated, straight on the thread.
 *
 * Falls back to T3's own `/pair#token=` flow (auto-pairs, lands on app home) if
 * redemption fails, and to the bare `/pair` paste form if T3 is down.
 */
app.get("/api/t3/threads/:threadId/open", async (c) => {
  const threadId = c.req.param("threadId");
  try {
    const origin = t3Origin();
    const credential = await issuePairingToken();
    const res = await fetch(`${origin}/api/auth/browser-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (res.ok && setCookies.length > 0) {
      for (const cookie of setCookies) c.header("set-cookie", cookie, { append: true });
      return c.redirect(`${origin}/${readEnvironmentId()}/${threadId}`, 302);
    }
    // Redemption didn't yield a cookie (the credential is unused on a non-2xx) —
    // fall back to the SPA pairing route, which auto-redeems and lands on home.
    log.warn(`browser-session redemption returned ${res.status} — falling back to /pair#token`);
    return c.redirect(t3PairingUrl(credential), 302);
  } catch (error) {
    log.warn("thread open failed — opening the pairing form:", String(error));
    return c.redirect(`${t3Origin()}/pair`, 302);
  }
});

app.get("/api/loops", (c) => c.json(loopsRepo.all().map(toApiLoop)));

// Live PR status is fetched via `gh` (a GraphQL query), which is too slow to
// inline on every loop row. The dashboard polls this batch endpoint separately;
// this cache keyed by repo+PR keeps the event-driven refreshes from hammering
// `gh` — and, critically, from exhausting GitHub's GraphQL rate budget, which
// silently degrades every PR badge and review-thread fetch when blown.
const PR_STATUS_TTL_MS = 30_000;
const prStatusCache = new Map<string, { at: number; status: PrStatus }>();

// `merged`/`closed` are final — a PR never leaves them — so once observed we
// serve the cached status forever and stop spending GraphQL budget re-polling
// it. Most loops have long-since-merged PRs, so this is the bulk of the saving.
function isTerminalPr(status: PrStatus): boolean {
  return status.state === "merged" || status.state === "closed";
}

async function cachedPrStatus(repoPath: string, repoName: string, number: number): Promise<PrStatus | null> {
  const key = `${repoName}#${number}`;
  const hit = prStatusCache.get(key);
  if (hit && (isTerminalPr(hit.status) || Date.now() - hit.at < PR_STATUS_TTL_MS)) return hit.status;
  try {
    const status = await prStatus(repoPath, number);
    prStatusCache.set(key, { at: Date.now(), status });
    return status;
  } catch (error) {
    log.warn("pr-status fetch failed:", String(error));
    // Fall back to the last known status so a transient `gh` failure doesn't
    // blank the badge mid-loop.
    return hit?.status ?? null;
  }
}

// Map of loop id → live PR status, for every loop that has a PR. Registered
// before `/api/loops/:id` so the static segment isn't captured as an id.
app.get("/api/loops/pr-status", async (c) => {
  const loops = loopsRepo.all().filter((l) => l.pr_number);
  const entries = await Promise.all(
    loops.map(async (loop) => {
      const repo = findRepo(loop.repo_name);
      if (!repo || !loop.pr_number) return null;
      const status = await cachedPrStatus(repo.localPath, loop.repo_name, loop.pr_number);
      return status ? ([loop.id, status] as const) : null;
    }),
  );
  return c.json(Object.fromEntries(entries.filter((e): e is readonly [string, PrStatus] => e !== null)));
});

app.get("/api/loops/:id", (c) => {
  const loop = loopsRepo.get(c.req.param("id"));
  if (!loop) return c.json({ error: "not found" }, 404);
  return c.json({
    ...toApiLoop(loop),
    // The task's full round chain (oldest first), so the UI can show the
    // journey across human-review rounds and navigate between them.
    rounds: loopsRepo.byIssue(loop.issue_id).reverse().map(toApiLoop),
    iterations: iterationsRepo.forLoop(loop.id).map((it) => ({
      n: it.n,
      verdict: it.verdict,
      findings: it.findings_json ? JSON.parse(it.findings_json) : [],
      startedAt: it.started_at,
      reviewedAt: it.reviewed_at,
      qaVerdict: it.qa_verdict,
      qaReviewedAt: it.qa_reviewed_at,
      // Screenshots are served by index, never by their on-disk path.
      qaScreenshots: (it.qa_screenshots_json
        ? (JSON.parse(it.qa_screenshots_json) as Array<{ path: string; label?: string }>)
        : []
      ).map((s, i) => ({ label: s.label ?? null, url: `/api/loops/${loop.id}/qa/${it.n}/screenshots/${i}` })),
    })),
    events: eventsRepo.forLoop(loop.id).map((e) => ({
      kind: e.kind,
      data: e.data_json ? JSON.parse(e.data_json) : null,
      at: e.created_at,
    })),
    firstMessagePreview: firstMessage(loop),
  });
});

/**
 * Unresolved human review threads on the loop's PR. The loop page polls this
 * for finished loops to offer starting an Address-Review Round.
 */
app.get("/api/loops/:id/review-threads", async (c) => {
  const loop = loopsRepo.get(c.req.param("id"));
  if (!loop) return c.json({ error: "not found" }, 404);
  const repo = findRepo(loop.repo_name);
  if (!loop.pr_number || !repo) return c.json({ prOpen: false, threads: [] });
  if ((await prState(repo.localPath, loop.pr_number)) !== "OPEN") {
    return c.json({ prOpen: false, threads: [] });
  }
  return c.json({ prOpen: true, threads: await unresolvedReviewThreads(repo.localPath, loop.pr_number) });
});

app.get("/api/loops/:id/reviews/:n", (c) => {
  const loop = loopsRepo.get(c.req.param("id"));
  if (!loop) return c.json({ error: "not found" }, 404);
  const stored = iterationsRepo.get(loop.id, Number(c.req.param("n")))?.review_doc_path;
  const docPath = stored ? resolveDataPath(stored) : null;
  if (!docPath || !fs.existsSync(docPath)) return c.json({ error: "no review doc" }, 404);
  return c.text(fs.readFileSync(docPath, "utf8"));
});

/** The archived QA-RESULT.md for an iteration, raw markdown (or 404). */
app.get("/api/loops/:id/qa/:n", (c) => {
  const loop = loopsRepo.get(c.req.param("id"));
  if (!loop) return c.json({ error: "not found" }, 404);
  const stored = iterationsRepo.get(loop.id, Number(c.req.param("n")))?.qa_doc_path;
  const docPath = stored ? resolveDataPath(stored) : null;
  if (!docPath || !fs.existsSync(docPath)) return c.json({ error: "no qa doc" }, 404);
  return c.text(fs.readFileSync(docPath, "utf8"));
});

/** An archived QA screenshot, served by its index in the iteration's manifest. */
app.get("/api/loops/:id/qa/:n/screenshots/:idx", (c) => {
  const loop = loopsRepo.get(c.req.param("id"));
  if (!loop) return c.json({ error: "not found" }, 404);
  const json = iterationsRepo.get(loop.id, Number(c.req.param("n")))?.qa_screenshots_json;
  const images = json ? (JSON.parse(json) as Array<{ path: string }>) : [];
  const image = images[Number(c.req.param("idx"))];
  const imagePath = image ? resolveDataPath(image.path) : null;
  if (!imagePath || !fs.existsSync(imagePath)) return c.json({ error: "no screenshot" }, 404);
  return new Response(Bun.file(imagePath), {
    headers: { "Cache-Control": "public, max-age=86400" },
  });
});

/**
 * The full human-review dialogue on the loop's PR — every review thread
 * (resolved + unresolved) with its comment chain. The loop feed renders this
 * between rounds, since each follow-up round is triggered by human review;
 * resolved threads are the comments that were addressed along the way.
 */
app.get("/api/loops/:id/pr-review", async (c) => {
  const loop = loopsRepo.get(c.req.param("id"));
  if (!loop) return c.json({ error: "not found" }, 404);
  const repo = findRepo(loop.repo_name);
  if (!loop.pr_number || !repo) return c.json({ prOpen: false, threads: [] });
  // Reuse the shared PR-status cache for open/closed rather than spending a
  // second GraphQL query on `prState` — a draft still counts as open for review.
  const status = await cachedPrStatus(repo.localPath, loop.repo_name, loop.pr_number);
  const prOpen = status ? status.state === "open" || status.state === "draft" : false;
  let threads: ReviewThread[] = [];
  try {
    threads = await allReviewThreads(repo.localPath, loop.pr_number);
  } catch (error) {
    log.warn("pr-review: review threads fetch failed:", String(error));
  }
  return c.json({ prOpen, threads });
});

app.post("/api/loops/:id/cancel", async (c) => {
  const loop = loopsRepo.get(c.req.param("id"));
  if (!loop) return c.json({ error: "not found" }, 404);
  return c.json(toApiLoop(await cancelLoop(loop)));
});

app.post("/api/loops/:id/retry", (c) => {
  const loop = loopsRepo.get(c.req.param("id"));
  if (!loop) return c.json({ error: "not found" }, 404);
  return c.json(toApiLoop(retryLoop(loop)));
});

app.post("/api/loops/:id/one-more", (c) => {
  const loop = loopsRepo.get(c.req.param("id"));
  if (!loop) return c.json({ error: "not found" }, 404);
  return c.json(toApiLoop(oneMoreRound(loop)));
});

/**
 * Resolve a loop's QA Companion Repo target, or a 4xx reason. A missing repo /
 * unconfigured companion / branchless loop means the QA-build control shouldn't
 * show — the web client treats these 4xx as "render nothing".
 */
function qaCompanionTarget(id: string): { cwd: string; taskBranch: string } | { error: string; status: 400 | 404 } {
  const loop = loopsRepo.get(id);
  if (!loop) return { error: "not found", status: 404 };
  const repo = findRepo(loop.repo_name);
  if (!repo?.qaCompanionPath) return { error: "no QA companion repo configured for this repo", status: 404 };
  if (!loop.task_branch) return { error: "loop has no task branch yet", status: 400 };
  return { cwd: expandHome(repo.qaCompanionPath), taskBranch: loop.task_branch };
}

/** Where the QA Companion Repo stands relative to this loop's Task Branch. */
app.get("/api/loops/:id/qa-repo", async (c) => {
  const target = qaCompanionTarget(c.req.param("id"));
  if ("error" in target) return c.json({ error: target.error }, target.status);
  return c.json(await qaRepoStatus(target.cwd, target.taskBranch));
});

/** Checkout-or-pull the loop's Task Branch in its QA Companion Repo. */
app.post("/api/loops/:id/qa-repo/checkout", async (c) => {
  const target = qaCompanionTarget(c.req.param("id"));
  if ("error" in target) return c.json({ error: target.error }, target.status);
  return c.json(await qaRepoCheckout(target.cwd, target.taskBranch));
});

/** Manually run the QA smoke gate against a finished loop's existing PR. */
app.post("/api/loops/:id/qa-probe", async (c) => {
  const loop = loopsRepo.get(c.req.param("id"));
  if (!loop) return c.json({ error: "not found" }, 404);
  const res = await runQaProbe(loop);
  if (!res.ok) return c.json({ error: res.message ?? "QA probe failed" }, 409);
  return c.json(toApiLoop(loopsRepo.get(loop.id)!));
});

app.get("/api/stats", (c) => {
  const all = loopsRepo.all();
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const byState = (s: string) => all.filter((l) => l.state === s).length;
  const approved = all.filter((l) => l.state === "approved");
  const exhausted = all.filter((l) => l.state === "exhausted");
  const terminalWithDuration = all.filter((l) => l.terminal_at);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return c.json({
    active: byState("running"),
    queued: byState("queued"),
    blocked: byState("blocked"),
    paused: byState("paused"),
    completedThisWeek: all.filter((l) => l.state === "approved" && l.terminal_at && l.terminal_at >= weekAgo).length,
    approvalRate: approved.length + exhausted.length > 0 ? approved.length / (approved.length + exhausted.length) : null,
    avgIterations: avg(approved.map((l) => l.iteration)),
    avgWallClockMs: avg(
      terminalWithDuration.map((l) => new Date(l.terminal_at!).getTime() - new Date(l.created_at).getTime()),
    ),
  });
});

// Aggregated T3 Code token usage, read straight from T3's orchestration event
// log (state.sqlite) — independent of whether the T3 server is running.
app.get("/api/usage", (c) => c.json(readTokenUsage()));

// Account usage windows (current session + weekly), the same data Claude Code's
// `/usage` shows — fetched from Anthropic's OAuth usage endpoint using the
// Claude Code credential in the login Keychain.
app.get("/api/rate-limits", async (c) => c.json(await readRateLimits()));

app.get("/api/events", (c) =>
  streamSSE(c, async (stream) => {
    const unsubscribe = onEvent((event) => {
      void stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
    });
    stream.onAbort(() => unsubscribe());
    // keepalive ping every 25s so proxies/browsers keep the stream open
    while (!stream.aborted) {
      await stream.writeSSE({ event: "ping", data: String(Date.now()) });
      await stream.sleep(25_000);
    }
  }),
);
