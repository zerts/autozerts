export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Precise elapsed time for the timing breakdown — seconds under a minute,
 * minutes under an hour, then `Xh Ym`. Unlike {@link formatDuration} it never
 * rounds a 90-second span up to "2m" or collapses multi-day spans to "d".
 */
export function formatDurationPrecise(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1_000))}s`;
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (hours < 24) return `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Compact token count, e.g. 940, 12.3K, 1.4M, 2.05B. */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (n < 1_000_000) return `${trim(n / 1_000)}K`;
  if (n < 1_000_000_000) return `${trim(n / 1_000_000)}M`;
  return `${(n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, "")}B`;
}

/** Reset time relative to now: "in 2h 14m" when near, an absolute date when far, "reset" once past. */
export function formatReset(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "reset";
  if (ms < 24 * 60 * 60_000) return `in ${formatDurationPrecise(ms)}`;
  return formatDate(iso);
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms >= 24 * 60 * 60_000) return formatDate(iso);
  return `${formatDuration(ms)} ago`;
}

/** Absolute date with weekday, e.g. "Sat, Jun 14". */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

import type { ApiLoop, LoopDetail, LoopState } from "./api";

/** A round is settled once it reaches one of these — no more work will run. */
export function isTerminalState(state: LoopState): boolean {
  return state === "approved" || state === "exhausted" || state === "cancelled" || state === "error";
}

export interface IterationTiming {
  n: number;
  /** Wall-clock from this iteration's start to its review/QA verdict (or null if still open). */
  ms: number | null;
  verdict: string | null;
  qaVerdict: string | null;
}

export interface LoopTiming {
  /** Whole round: created → terminal (or → now while still running). */
  totalMs: number;
  running: boolean;
  /** Created → first open PR (the `gate.passed` event), or null if no PR yet. */
  toPrMs: number | null;
  iterations: IterationTiming[];
}

/**
 * Derive a round's timing breakdown from the data the loop detail already
 * carries — no extra request. Per-iteration spans run from the iteration's
 * `startedAt` to whichever verdict landed last (review or QA), falling back to
 * the next iteration's start, then the round's end.
 */
export function loopTiming(detail: LoopDetail): LoopTiming {
  const createdMs = new Date(detail.createdAt).getTime();
  const endMs = detail.terminalAt ? new Date(detail.terminalAt).getTime() : Date.now();

  const gate = detail.events.find((e) => e.kind === "gate.passed");
  const toPrMs = gate ? new Date(gate.at).getTime() - createdMs : null;

  const its = detail.iterations;
  const iterations: IterationTiming[] = its.map((it, i) => {
    const start = new Date(it.startedAt).getTime();
    const verdictMs = [it.reviewedAt, it.qaReviewedAt]
      .filter((t): t is string => Boolean(t))
      .map((t) => new Date(t).getTime());
    const nextStart = its[i + 1] ? new Date(its[i + 1].startedAt).getTime() : null;
    const end = verdictMs.length ? Math.max(...verdictMs) : nextStart ?? (detail.terminalAt ? endMs : null);
    return {
      n: it.n,
      ms: end !== null && end > start ? end - start : null,
      verdict: it.verdict,
      qaVerdict: it.qaVerdict,
    };
  });

  return { totalMs: Math.max(0, endMs - createdMs), running: !detail.terminalAt, toPrMs, iterations };
}

/** Hostname of a URL for display, falling back to the raw string if unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Strip the project prefix the icon replaces (e.g. "Web: Fix login" → "Fix login"). */
export function displayTitle(title: string, titlePrefix: string | null | undefined): string {
  if (titlePrefix && title.startsWith(titlePrefix)) return title.slice(titlePrefix.length);
  return title;
}

/**
 * Human description of what a loop is doing right now.
 *
 * Pass `omitState` when the text sits next to a visible StateBadge — settled
 * loops then report just the iteration count instead of repeating the state
 * name the badge already shows.
 */
export function loopActivity(loop: ApiLoop, opts?: { omitState?: boolean }): string {
  if (loop.state === "blocked") return loop.blockedReason ?? "waiting";
  if (loop.state === "error") return loop.errorMessage ?? "error";
  if (loop.state === "paused") return "T3 Code unavailable";
  if (loop.state === "queued") return "waiting for a slot";
  // Settled rounds: show the outcome plus how many implement→review cycles it
  // took, not the stale live step (`loop.step` lingers on "review-dispatch").
  // The "/maxIterations" limit is dropped — it's only meaningful while running.
  if (loop.state === "approved" || loop.state === "exhausted" || loop.state === "cancelled") {
    const n = loop.iteration;
    const count = `${n} ${n === 1 ? "iteration" : "iterations"}`;
    return opts?.omitState ? count : `${loop.state} · ${count}`;
  }
  switch (loop.step) {
    case "impl":
      return "implementing";
    case "gate":
      return "waiting for PR";
    case "qa-start":
    case "qa-dispatch":
      return `QA check (iteration ${loop.iteration}/${loop.maxIterations})`;
    case "review-start":
    case "review-dispatch":
      return `reviewing (iteration ${loop.iteration}/${loop.maxIterations})`;
    case "fix-start":
    case "fix-dispatch":
      return `fixing (iteration ${loop.iteration}/${loop.maxIterations})`;
    case "push-gate":
      return "verifying push";
    default:
      return loop.phase;
  }
}
