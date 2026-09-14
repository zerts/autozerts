export type LoopState =
  | "queued"
  | "running"
  | "blocked"
  | "paused"
  | "approved"
  | "exhausted"
  | "cancelled"
  | "error";

export interface ApiLoop {
  id: string;
  issue: { id: string; identifier: string; title: string; url: string };
  repo: string;
  /** Runner-hosted URL of the project icon for this loop's repo, or null. */
  iconUrl: string | null;
  /** Configured project accent color (CSS string), or null → derive from icon. */
  gradient: string | null;
  /** Leading title substring (e.g. "Web: ") the icon stands in for, or null. */
  titlePrefix: string | null;
  state: LoopState;
  phase: "implementing" | "qa" | "reviewing" | "fixing";
  step: string | null;
  round: "initial" | "address-review";
  iteration: number;
  maxIterations: number;
  taskBranch: string | null;
  pr: { number: number; url: string | null } | null;
  // NOTE: live PR status (open/merged/checks) is not on the loop row — it's
  // fetched separately via `api.prStatuses()`; see the `PrStatus` type below.
  /** CI "deployed to domain" dev-build link, captured once it appears on the PR. */
  devBuildUrl: string | null;
  autonomous: boolean;
  forceGrill: boolean;
  /** Whether the QA smoke gate is enabled for this loop's repo. */
  qaGate: boolean;
  /** Whether this loop's repo has a QA Companion Repo configured (shows the QA-build control). */
  qaCompanion: boolean;
  /** Shared staging deploy URL for this loop's repo, or null when none is configured. */
  stagingUrl: string | null;
  /** T3 Claude slug for implementation, or null when the config default is used. */
  model: string | null;
  /** T3 Claude slug for review, or null when it reuses the implementation model. */
  reviewModel: string | null;
  blockedReason: string | null;
  errorMessage: string | null;
  threads: {
    implementation: { t3ThreadId: string; url: string; openUrl: string } | null;
    review: { t3ThreadId: string; url: string; openUrl: string } | null;
  };
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

/** A PR's live status: its lifecycle plus the rolled-up CI check result. */
export interface PrStatus {
  state: "open" | "draft" | "merged" | "closed";
  /** CI rollup across every check, or null when the PR has no checks. */
  checks: "passing" | "failing" | "pending" | null;
}

export interface LoopDetail extends ApiLoop {
  /** All loops for the same issue (oldest first) — the task's round chain. */
  rounds: ApiLoop[];
  iterations: Array<{
    n: number;
    verdict: string | null;
    findings: Array<{ severity: string; area: string; title: string; file?: string }>;
    startedAt: string;
    reviewedAt: string | null;
    /** QA smoke-gate verdict for this iteration, or null when the gate didn't run. */
    qaVerdict: string | null;
    qaReviewedAt: string | null;
    /** Archived QA screenshots, each served by the runner. */
    qaScreenshots: Array<{ label: string | null; url: string }>;
  }>;
  events: Array<{ kind: string; data: unknown; at: string }>;
  firstMessagePreview: string;
}

export interface ApiIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { name: string; type: string };
  priority: number;
  labels: string[];
  updatedAt: string;
  defaultRepo: string | null;
  /** Project icon URL derived from the title prefix, or null when no prefix matched. */
  iconUrl: string | null;
  /** Configured project accent color (CSS string), or null → derive from icon. */
  gradient: string | null;
  /** Leading title substring (e.g. "Web: ") the icon stands in for, or null. */
  titlePrefix: string | null;
  loop: ApiLoop | null;
}

export interface ReviewThread {
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  /** When the thread was last resolved (ISO), or null if still open. */
  resolvedAt: string | null;
  comments: Array<{ author: string; body: string }>;
}

export interface Stats {
  active: number;
  queued: number;
  blocked: number;
  paused: number;
  completedThisWeek: number;
  approvalRate: number | null;
  avgIterations: number | null;
  avgWallClockMs: number | null;
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

export interface RateLimitWindow {
  /** "session" | "weekly_all" | "weekly_scoped" | … */
  kind: string;
  group: string;
  /** Percent of the window consumed (0–100). */
  percent: number;
  severity: string;
  /** ISO timestamp the window resets, or null. */
  resetsAt: string | null;
  /** Model the window is scoped to (e.g. "Sonnet"), or null for all-models. */
  scopeModel: string | null;
  isActive: boolean;
}

export interface ExtraUsage {
  utilization: number;
  usedCredits: number;
  monthlyLimit: number;
  /** credits / 10^decimalPlaces = currency amount. */
  decimalPlaces: number;
  currency: string;
}

export interface RateLimits {
  /** False when the Claude Code token is missing/expired or the request failed. */
  available: boolean;
  /** Why it's unavailable, or null when available. */
  reason: string | null;
  windows: RateLimitWindow[];
  extra: ExtraUsage | null;
  generatedAt: string;
}

export interface Health {
  status: string;
  t3: "up" | "down";
  gh: string;
  linearConfigured: boolean;
  repos: string[];
  /** Per-repo quick links: project icon + GitHub pull requests page. */
  repoLinks: Array<{ name: string; iconUrl: string | null; prsUrl: string | null; labels: string[] }>;
  /** Curated short list of Claude models offered when starting a loop. */
  models: Array<{ id: string; label: string }>;
  /** The config-default model used when no model is chosen. */
  defaultModel: string;
}

export interface RepoConfigView {
  name: string;
  localPath: string;
  defaultBranch: string;
  issuePrefixes: string[];
  /** Raw labels that map an issue to this repo; empty falls back to prefixes. */
  labels: string[];
  /** Raw icon value (http(s) URL or local path), or empty when none. */
  icon: string;
  /** Runner-hosted project icon URL, or null when none is configured. */
  iconUrl: string | null;
  /** Project accent color override (CSS string), or empty → derive from icon. */
  gradient: string;
  /** Whether the QA smoke gate runs for this repo. */
  qaGate: boolean;
  /** Dev-server port the QA gate serves this repo on, or null → default 3000. */
  qaPort: number | null;
  /** Path to this repo's QA Companion Repo, or empty when none. */
  qaCompanionPath: string;
  /** Shared staging deploy URL, or empty when none. */
  stagingUrl: string;
}

/** The editable subset of a repo sent back when saving config. */
export type RepoConfigInput = Pick<
  RepoConfigView,
  "name" | "localPath" | "defaultBranch" | "issuePrefixes" | "labels" | "icon" | "gradient" | "qaGate" | "qaPort" | "qaCompanionPath" | "stagingUrl"
>;

/** Where a loop's QA Companion Repo stands relative to its Task Branch. */
export interface QaRepoStatus {
  currentBranch: string | null;
  taskBranch: string;
  onBranch: boolean;
  unpulled: number;
  /** Set when the QA repo is unusable (bad path, not a git repo, fetch failed). */
  error?: string;
}

export interface AppConfig {
  port: number;
  linearConfigured: boolean;
  dataDir: string;
  logFile: string;
  maxParallelLoops: number;
  maxIterations: number;
  /** Config-default Claude model used when a loop chooses none. */
  defaultModel: string;
  /** Curated Claude models offered when starting a loop. */
  models: Array<{ id: string; label: string }>;
  repos: RepoConfigView[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<Health>("/api/health"),
  config: () => request<AppConfig>("/api/config"),
  saveRepos: (repos: RepoConfigInput[]) =>
    request<AppConfig>("/api/config/repos", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repos }),
    }),
  saveDefaultModel: (model: string) =>
    request<AppConfig>("/api/config/default-model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    }),
  stats: () => request<Stats>("/api/stats"),
  usage: () => request<TokenUsage>("/api/usage"),
  rateLimits: () => request<RateLimits>("/api/rate-limits"),
  loops: () => request<ApiLoop[]>("/api/loops"),
  /** Map of loop id → live PR status, for every loop that has a PR. */
  prStatuses: () => request<Record<string, PrStatus>>("/api/loops/pr-status"),
  loop: (id: string) => request<LoopDetail>(`/api/loops/${id}`),
  reviewDoc: (id: string, n: number) =>
    fetch(`/api/loops/${id}/reviews/${n}`).then((r) => (r.ok ? r.text() : null)),
  qaDoc: (id: string, n: number) =>
    fetch(`/api/loops/${id}/qa/${n}`).then((r) => (r.ok ? r.text() : null)),
  loopReviewThreads: (id: string) =>
    request<{ prOpen: boolean; threads: ReviewThread[] }>(`/api/loops/${id}/review-threads`),
  prReviewThreads: (id: string) =>
    request<{ prOpen: boolean; threads: ReviewThread[] }>(`/api/loops/${id}/pr-review`),
  issues: () => request<ApiIssue[]>("/api/issues"),
  select: (
    ref: string,
    body: { repo?: string; extras?: string; autonomous?: boolean; forceGrill?: boolean; model?: string; reviewModel?: string },
  ) =>
    request<{ action: string; loop: ApiLoop; message?: string; unresolvedThreads?: ReviewThread[] }>(
      `/api/tasks/${encodeURIComponent(ref)}/select`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  addressReview: (ref: string, body: { extras?: string } = {}) =>
    request<{ action: string; loop: ApiLoop; message?: string }>(`/api/tasks/${encodeURIComponent(ref)}/address-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  cancel: (id: string) => request<ApiLoop>(`/api/loops/${id}/cancel`, { method: "POST" }),
  retry: (id: string) => request<ApiLoop>(`/api/loops/${id}/retry`, { method: "POST" }),
  oneMore: (id: string) => request<ApiLoop>(`/api/loops/${id}/one-more`, { method: "POST" }),
  /** QA Companion Repo status for a loop, or null when the repo has none configured (4xx). */
  qaRepoStatus: (id: string): Promise<QaRepoStatus | null> =>
    fetch(`/api/loops/${id}/qa-repo`).then((r) => (r.ok ? (r.json() as Promise<QaRepoStatus>) : null)),
  /** Checkout-or-pull the loop's Task Branch in its QA Companion Repo. */
  qaRepoCheckout: (id: string) =>
    request<QaRepoStatus>(`/api/loops/${id}/qa-repo/checkout`, { method: "POST" }),
  qaProbe: async (id: string): Promise<ApiLoop> => {
    const res = await fetch(`/api/loops/${id}/qa-probe`, { method: "POST" });
    const body = (await res.json()) as ApiLoop & { error?: string };
    if (!res.ok) throw new Error(body.error ?? "QA probe failed");
    return body;
  },
};

/** Subscribe to the runner's SSE stream; calls onChange on every loop/stats event. */
export function subscribeEvents(onChange: () => void): () => void {
  const source = new EventSource("/api/events");
  source.addEventListener("loop.updated", onChange);
  source.addEventListener("stats.updated", onChange);
  source.addEventListener("t3.availability", onChange);
  return () => source.close();
}
