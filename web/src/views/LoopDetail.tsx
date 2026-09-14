import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PrStatusBadge, PrStatusIcon } from "@/components/PrStatusBadge";
import { RoundSection } from "@/components/RoundSection";
import { HumanReview } from "@/components/HumanReview";
import { AttachmentRow } from "@/components/AttachmentRow";
import { QaBuildCard } from "@/components/QaBuildCard";
import { Markdown } from "@/components/Markdown";
import { api, type LoopDetail as LoopDetailData, type PrStatus, type QaRepoStatus, type ReviewThread } from "@/lib/api";
import { hostOf, loopActivity, timeAgo } from "@/lib/format";
import { digitForIndex, indexForCode, isTypingTarget } from "@/lib/shortcuts";
import { ArrowLeft, Check, Copy, ExternalLink, FlaskConical, GitPullRequest, Globe, MessageSquare, Terminal } from "lucide-react";

interface QuickLink {
  icon: LucideIcon;
  title: string;
  subtitle?: string | null;
  href: string;
  /** Optional icon shown inline after the title (e.g. live PR status on the PR row). */
  titleAdornment?: ReactNode;
  /** Render dimmer/dashed — a shared, overwritable link (e.g. staging). */
  unstable?: boolean;
}

/**
 * Group review threads by the round that resolved them, so each human-review
 * separator shows only the comments that the *following* round addressed.
 *
 * The separator rendered before `rounds[i]` (i ≥ 1) represents the review that
 * round consumed, so it gets the threads whose resolution falls inside round
 * `i`'s active window — `[rounds[i].createdAt, rounds[i+1].createdAt)`. Threads
 * resolved during the initial round (no separator) fold into the first one, and
 * still-open threads (no resolution time) fall into the most recent separator.
 *
 * Returns an array indexed by round; entry 0 is unused (there's no separator
 * before the first round).
 */
function threadsByRound(rounds: { createdAt: string }[], threads: ReviewThread[]): ReviewThread[][] {
  const buckets: ReviewThread[][] = rounds.map(() => []);
  if (rounds.length < 2) return buckets;
  const last = rounds.length - 1;
  const starts = rounds.map((r) => new Date(r.createdAt).getTime());

  for (const thread of threads) {
    let section = last; // open threads → newest review; resolved ones get placed below
    if (thread.resolvedAt) {
      const t = new Date(thread.resolvedAt).getTime();
      // The round whose window contains the resolution: last start ≤ t.
      let i = 0;
      while (i + 1 < starts.length && starts[i + 1] <= t) i++;
      section = Math.min(Math.max(i, 1), last); // clamp into the [1, last] separators
    }
    buckets[section].push(thread);
  }
  return buckets;
}

/** The task branch name, click to copy to the clipboard. */
function CopyBranch({ branch }: { branch: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(branch);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — silently ignore.
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy branch name"
      className="group inline-flex max-w-full items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
    >
      <code className="truncate text-xs">{branch}</code>
      {copied ? (
        <Check className="size-3 shrink-0 text-success" />
      ) : (
        <Copy className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  );
}

export function LoopDetail({
  id,
  onBack,
  onOpenLoop,
  prStatuses,
  refreshKey,
}: {
  id: string;
  onBack: () => void;
  onOpenLoop: (id: string) => void;
  /** Live PR status by loop id, fetched at the app level and shared with My Work. */
  prStatuses: Record<string, PrStatus>;
  refreshKey: number;
}) {
  // Every round of the task, oldest first, each with its full detail — the feed
  // shows them stacked, so there's no selector to switch between loops.
  const [rounds, setRounds] = useState<LoopDetailData[] | null>(null);
  const [prThreads, setPrThreads] = useState<{ prOpen: boolean; threads: ReviewThread[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // QA Companion Repo standing for this loop's branch — null until loaded, and
  // stays null when the repo has no companion configured (the API 4xx's). State
  // lives here, not in the card, so the inline + sticky-rail renders of the
  // card stay in sync and the keyboard shortcut has one action to fire.
  const [qaStatus, setQaStatus] = useState<QaRepoStatus | null>(null);
  const [qaBusy, setQaBusy] = useState(false);
  // The quick links are computed below, after the early returns, but the
  // keyboard handler is registered once up here — so it reads them off a ref.
  const linksRef = useRef<QuickLink[]>([]);
  // The QA-build card's action, refreshed each render (null when no card / busy)
  // so its Shift+number shortcut fires the same checkout-or-pull as a click.
  const qaActivateRef = useRef<(() => void) | null>(null);

  async function loadRounds() {
    const head = await api.loop(id);
    const details = await Promise.all(head.rounds.map((r) => api.loop(r.id)));
    setRounds(details);
    return details;
  }

  useEffect(() => {
    loadRounds().catch((e) => setError(String(e)));
  }, [id, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The human-review dialogue lives on the shared PR, so one fetch covers the
  // whole task. Resolved threads are the comments addressed along the way.
  useEffect(() => {
    api.prReviewThreads(id).then(setPrThreads).catch(() => setPrThreads(null));
  }, [id, refreshKey]);

  // QA Companion Repo standing — fetched (with a `git fetch`) behind the card's
  // own loading state, refreshed when the page refreshes. A 4xx (no companion
  // repo configured) resolves to null, so the card simply doesn't render.
  useEffect(() => {
    api.qaRepoStatus(id).then(setQaStatus).catch(() => setQaStatus(null));
  }, [id, refreshKey]);

  // Shift+number (Shift+1…9, Shift+0) jumps to the Nth rail item: a link opens
  // in a new tab; the QA-build card (appended after the links) fires its action.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const index = indexForCode(e.code);
      if (index < 0) return;
      const links = linksRef.current;
      if (index < links.length) {
        e.preventDefault();
        window.open(links[index].href, "_blank", "noopener,noreferrer");
      } else if (index === links.length && qaActivateRef.current) {
        e.preventDefault();
        qaActivateRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (error) return <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>;
  if (!rounds || rounds.length === 0) return null;

  const latest = rounds[rounds.length - 1];
  const prStatus = prStatuses[latest.id];
  const threads = prThreads?.threads ?? [];
  const unresolved = threads.filter((t) => !t.isResolved);
  // Each human-review separator shows only the threads the following round
  // resolved (open ones land under the most recent separator).
  const threadsBySection = threadsByRound(rounds, threads);
  const canAddressReview =
    (latest.state === "approved" || latest.state === "exhausted") &&
    latest.pr !== null &&
    prThreads?.prOpen === true &&
    unresolved.length > 0;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await loadRounds();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Checkout-or-pull the loop's branch in the QA Companion Repo; the server
  // decides which from the repo's current branch. Re-reads status from the
  // response, so no follow-up fetch is needed.
  function runQaAction() {
    setQaBusy(true);
    api
      .qaRepoCheckout(latest.id)
      .then(setQaStatus)
      .catch((e) => setError(String(e)))
      .finally(() => setQaBusy(false));
  }

  function startAddressReview() {
    setBusy(true);
    api
      .addressReview(latest.issue.identifier)
      .then((res) => {
        if (res.loop.id !== latest.id) onOpenLoop(res.loop.id);
        else if (res.message) setError(res.message);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  }

  // The web app has no QA companion card — its Dev build deploy *is* the QA
  // instance, so it's pulled to the bottom of the rail to line up with the
  // QA-build card other repos render there. Everywhere else it sits up top,
  // right under the PR.
  const devBuildLast = latest.repo === "zerion-web-app";
  const devBuildLink: QuickLink[] = latest.devBuildUrl
    ? [{ icon: Globe, title: "Dev build", subtitle: hostOf(latest.devBuildUrl), href: latest.devBuildUrl }]
    : [];

  // Linear-style attachments: one full-width row per external link. Built as a
  // descriptor list (conditionals collapse to the rows that exist) so each row
  // gets a sequential number — both for the visible badge and the keyboard
  // shortcut that opens it.
  const links: QuickLink[] = [
    { icon: ExternalLink, title: "Linear task", subtitle: latest.issue.identifier, href: latest.issue.url },
    ...(latest.pr?.url
      ? [{
          icon: GitPullRequest,
          title: "Pull request",
          subtitle: `${latest.repo} · #${latest.pr.number}`,
          href: latest.pr.url,
          titleAdornment: prStatus ? <PrStatusIcon status={prStatus} /> : undefined,
        }]
      : []),
    ...(devBuildLast ? [] : devBuildLink),
    ...(latest.threads.implementation
      ? [{ icon: Terminal, title: "Implementation thread", subtitle: `T3 Code · ${latest.threads.implementation.t3ThreadId}`, href: latest.threads.implementation.openUrl }]
      : []),
    ...(latest.threads.review
      ? [{ icon: Terminal, title: "Review thread", subtitle: `T3 Code · ${latest.threads.review.t3ThreadId}`, href: latest.threads.review.openUrl }]
      : []),
    // Kept last and styled as unstable: a shared staging deploy other branches
    // can overwrite, so it's handy but not a reliable view of this PR.
    ...(latest.stagingUrl
      ? [{ icon: FlaskConical, title: "Staging", subtitle: `${hostOf(latest.stagingUrl)} · shared`, href: latest.stagingUrl, unstable: true }]
      : []),
    // Web app: Dev build deploy lands last, aligned with other repos' QA card.
    ...(devBuildLast ? devBuildLink : []),
  ];
  linksRef.current = links;

  // The QA-build card (extension loops with a companion repo) is the last rail
  // item, so it claims the next Shift+number after the links. Expose its action
  // for the shortcut only while it's actionable — null when absent or busy.
  const showQaCard = latest.qaCompanion && qaStatus !== null;
  qaActivateRef.current = showQaCard && !qaBusy ? runQaAction : null;
  const qaShortcut = showQaCard ? digitForIndex(links.length) ?? undefined : undefined;

  // Rendered in two places — inline after the card on narrow screens, and as a
  // sticky right rail on wide screens — so the same markup drives both layouts.
  const attachments = (
    <>
      {links.map((link, i) => (
        <AttachmentRow
          key={link.href}
          icon={link.icon}
          title={link.title}
          titleAdornment={link.titleAdornment}
          subtitle={link.subtitle}
          href={link.href}
          shortcut={digitForIndex(i) ?? undefined}
          unstable={link.unstable}
        />
      ))}
      {showQaCard && qaStatus && (
        <QaBuildCard status={qaStatus} busy={qaBusy} onActivate={runQaAction} shortcut={qaShortcut} />
      )}
    </>
  );

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> My Work
      </button>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6">
      <div className="space-y-4 lg:min-w-0">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-muted-foreground">{latest.issue.identifier}</span>
                {prStatus && <PrStatusBadge status={prStatus} />}
                {rounds.length > 1 && (
                  <span className="text-xs text-muted-foreground">{rounds.length} rounds</span>
                )}
              </div>
              <CardTitle className="mt-1 text-base">{latest.issue.title}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {loopActivity(latest, { omitState: true })} · updated {timeAgo(latest.updatedAt)} · {latest.repo}
              </p>
              {latest.taskBranch && (
                <div className="mt-1 flex max-w-full">
                  <CopyBranch branch={latest.taskBranch} />
                </div>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              {(latest.state === "running" || latest.state === "blocked" || latest.state === "queued" || latest.state === "paused") && (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => act(() => api.cancel(latest.id))}>
                  Cancel
                </Button>
              )}
              {latest.state === "error" && (
                <Button size="sm" disabled={busy} onClick={() => act(() => api.retry(latest.id))}>
                  Retry last phase
                </Button>
              )}
              {latest.state === "exhausted" && (
                <Button size="sm" disabled={busy} onClick={() => act(() => api.oneMore(latest.id))}>
                  Run one more round
                </Button>
              )}
              {latest.qaGate &&
                latest.pr !== null &&
                (latest.state === "approved" || latest.state === "exhausted" || latest.state === "cancelled") && (
                  <Button variant="outline" size="sm" className="rounded-lg" disabled={busy} onClick={() => act(() => api.qaProbe(latest.id))}>
                    Run QA
                  </Button>
                )}
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Narrow screens: attachments stack inline right after the card. */}
      <div className="space-y-2 lg:hidden">{attachments}</div>

      {/* The feed: round #1 → human review → round #2 → … oldest at the top.
          Each separator shows only the comments the following round resolved. */}
      <div className="space-y-3">
        {rounds.map((round, i) => (
          <Fragment key={round.id}>
            {i > 0 && <HumanReview threads={threadsBySection[i]} />}
            <RoundSection detail={round} index={i} defaultOpen={i === rounds.length - 1} />
          </Fragment>
        ))}
      </div>

      {canAddressReview && (
        <Card className="bg-warning-soft/40">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <MessageSquare className="size-4 text-warning" />
                {unresolved.length} unresolved review {unresolved.length === 1 ? "comment" : "comments"} on the PR
              </CardTitle>
              <Button size="sm" disabled={busy} onClick={startAddressReview}>
                Address review
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {unresolved.map((thread, i) => (
              <div key={i} className="rounded-md bg-background px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="truncate font-mono">
                    {thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ""}` : "(general)"}
                  </span>
                  {thread.isOutdated && (
                    <span className="shrink-0 rounded-sm bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning">
                      outdated
                    </span>
                  )}
                </div>
                {thread.comments.map((comment, j) => (
                  <div key={j} className="mt-1.5 text-sm">
                    <span className="text-xs font-semibold text-muted-foreground">{comment.author}</span>
                    <Markdown className="mt-0.5 text-sm">{comment.body}</Markdown>
                  </div>
                ))}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      </div>

      {/* Wide screens: attachments become a sticky right rail. */}
      <aside className="hidden lg:flex lg:flex-col lg:gap-2 lg:sticky lg:top-16">
        {attachments}
      </aside>
      </div>
    </div>
  );
}
