import { useEffect, useState, type CSSProperties } from "react";
import { Markdown } from "@/components/Markdown";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, type LoopDetail as LoopDetailData } from "@/lib/api";
import { useProjectColor } from "@/lib/project-color";
import { formatDurationPrecise, isTerminalState, loopActivity, loopTiming, timeAgo } from "@/lib/format";
import { ChevronDown, ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

type Screenshot = { url: string; label?: string | null };

/**
 * A row of QA screenshot thumbnails that open into a single lightbox dialog.
 * When there is more than one shot, the dialog supports prev/next navigation
 * via on-screen side arrows and the ←/→ keyboard keys (with wrap-around).
 */
function QaScreenshotGallery({ shots, title }: { shots: Screenshot[]; title: string }) {
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const go = (delta: number) => setIndex((i) => (i + delta + shots.length) % shots.length);
  // Keep `index` after close so the current image stays rendered through the
  // dialog's exit animation instead of flashing the empty state.
  const shot = shots[index];

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {shots.map((s, i) => (
        <button
          key={i}
          type="button"
          onClick={() => {
            setIndex(i);
            setOpen(true);
          }}
          className="overflow-hidden rounded-md bg-background shadow-[var(--elevation)] transition-opacity hover:opacity-80"
          title={s.label ?? `Screenshot ${i + 1}`}
        >
          <img src={s.url} alt={s.label ?? `QA screenshot ${i + 1}`} className="h-24 w-auto object-cover" />
        </button>
      ))}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[90vh] grid-rows-[auto_minmax(0,1fr)] sm:max-w-5xl"
          onKeyDown={(e) => {
            if (shots.length < 2) return;
            if (e.key === "ArrowRight") {
              e.preventDefault();
              go(1);
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              go(-1);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle className="line-clamp-3 min-h-[3lh] leading-snug">
              {title} · {shot?.label ?? `Screenshot ${(index ?? 0) + 1}`}
              {shots.length > 1 && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {(index ?? 0) + 1} / {shots.length}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="relative min-h-0">
            {shot && (
              <img
                src={shot.url}
                alt={shot.label ?? `QA screenshot ${(index ?? 0) + 1}`}
                className="h-full w-full object-contain"
              />
            )}
            {shots.length > 1 && (
              <>
                <button
                  type="button"
                  aria-label="Previous screenshot"
                  onClick={() => go(-1)}
                  className="absolute left-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/70 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-background"
                >
                  <ChevronLeft className="size-5" />
                </button>
                <button
                  type="button"
                  aria-label="Next screenshot"
                  onClick={() => go(1)}
                  className="absolute right-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/70 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-background"
                >
                  <ChevronRight className="size-5" />
                </button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * One round of a task, rendered inline in the loop feed: its reviews (one tab
 * per reviewed iteration) and its event timeline. Collapsible so older rounds
 * fold away; the latest round is expanded by default. Review docs are fetched
 * per this round's id, since iteration numbers restart each round.
 */
export function RoundSection({
  detail,
  index,
  defaultOpen,
}: {
  detail: LoopDetailData;
  index: number;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [docs, setDocs] = useState<Record<number, string>>({});
  const terminal = isTerminalState(detail.state);
  // A finished round's timeline is just history — fold it away by default so the
  // reviews stay front-and-centre; a live round keeps it open to watch progress.
  const [timelineOpen, setTimelineOpen] = useState(!terminal);

  const reviewedIterations = detail.iterations.filter((it) => it.reviewedAt);
  const qaIterations = detail.iterations.filter((it) => it.qaVerdict);
  const timing = loopTiming(detail);

  // Same project tint as the loop card's icon tray (see ProjectCard): the
  // recessed backdrop behind the strip picks up the project's accent instead of
  // a plain neutral. Falls back to a hueless neutral for icon-less projects.
  const derived = useProjectColor(detail.repo ?? detail.iconUrl ?? "project", detail.iconUrl, detail.gradient);
  const hasProject = Boolean(detail.iconUrl || detail.gradient?.trim());
  const tint = hasProject ? derived : "var(--muted-foreground)";

  useEffect(() => {
    if (!open) return;
    for (const it of reviewedIterations) {
      if (docs[it.n] === undefined) {
        api.reviewDoc(detail.id, it.n).then((text) => {
          if (text !== null) setDocs((d) => ({ ...d, [it.n]: text }));
        });
      }
    }
  }, [open, detail.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    // Same shell as the my-work loop card (see ProjectCard): the top strip is a
    // recessed backdrop, and the expanded content sits on an elevated panel with
    // a rounded top edge + a shadow cast upward onto the strip.
    // The tint mix is stronger than ProjectCard's 14% tray: the strip is this
    // card's visual identity, so it leans into the project accent rather than
    // hiding it. The badge's current-color ring keeps it legible on top.
    <div
      className={cn(
        "relative isolate overflow-hidden rounded-xl shadow-[var(--elevation)] bg-[var(--strip)] transition-colors",
        // Drive the header's expanded hover from the wrapper, not the button, so
        // the whole strip AND the corner slivers the content panel's rounded top
        // exposes shift together — hovering the button alone would leave those
        // corners at the un-hovered tint. `>button` targets only the header
        // toggle (the content panel's buttons are nested, not direct children).
        "has-[>button:hover]:bg-[var(--strip-hover)]",
      )}
      style={{
        "--strip": `color-mix(in oklab, ${tint} 25%, var(--secondary))`,
        "--strip-hover": `color-mix(in oklab, var(--muted) 40%, color-mix(in oklab, ${tint} 25%, var(--secondary)))`,
      } as CSSProperties}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "group flex w-full items-center gap-2 rounded-xl px-4 py-2.5 text-left transition-colors",
          // Collapsed: the strip is the whole card, so give it the elevated card
          // surface. Expanded: it stays transparent so the wrapper's tint (and
          // its hover shift, handled above) shows through uniformly.
          open ? "" : "bg-card hover:bg-muted/20",
        )}
      >
        {open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
        <span className="text-sm font-semibold">Round #{index + 1}</span>
        {detail.round === "address-review" && (
          <span className="text-xs text-muted-foreground">address-review</span>
        )}
        {/* The strip behind the stats is tinted, so pin them onto the elevated
            card surface to keep their muted text legible against the accent. */}
        <span
          className={cn(
            "ml-auto flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-xs text-muted-foreground",
            // Collapsed, the strip already is the card surface, so the pill would
            // cast a shadow onto its own background — only lift it once the strip
            // parts from that surface: when expanded, or on hover (the header
            // shifts to the tinted/muted accent).
            open ? "shadow-[var(--elevation)]" : "group-hover:shadow-[var(--elevation)]",
          )}
        >
          <span className="inline-flex items-center gap-1" title={timing.running ? "Elapsed so far" : "Total wall-clock"}>
            <Clock className="size-3" />
            {formatDurationPrecise(timing.totalMs)}
            {timing.running && "…"}
          </span>
          <span aria-hidden>·</span>
          {loopActivity(detail, { omitState: true })} · {timeAgo(detail.updatedAt)}
        </span>
      </button>

      {open && (
        <div
          className="relative z-10 space-y-4 rounded-t-xl border-t bg-card px-4 py-4"
          style={{ boxShadow: "0 -8px 18px -6px var(--shadow-color), 0 -2px 6px -3px var(--shadow-color)" }}
        >
          {(detail.blockedReason || detail.errorMessage) && (
            <div
              className={cn(
                "rounded-md px-3 py-2 text-sm",
                detail.errorMessage
                  ? "bg-danger-soft text-danger"
                  : "bg-warning-soft text-warning",
              )}
            >
              {detail.errorMessage ?? detail.blockedReason}
            </div>
          )}

          {qaIterations.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">QA smoke gate</p>
              <div className="space-y-2">
                {qaIterations.map((it) => (
                  <div key={it.n} className="rounded-lg bg-muted/50 p-3">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium">#{it.n}</span>
                      <span
                        className={cn(
                          "rounded-sm px-1.5 py-0.5 text-[11px] font-medium",
                          it.qaVerdict === "pass" ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
                        )}
                      >
                        {it.qaVerdict === "pass" ? "✅ pass" : "🔴 fail"}
                      </span>
                      {it.qaReviewedAt && (
                        <span className="ml-auto text-xs text-muted-foreground">{timeAgo(it.qaReviewedAt)}</span>
                      )}
                    </div>
                    {it.qaScreenshots.length > 0 && (
                      <QaScreenshotGallery
                        shots={it.qaScreenshots}
                        title={`Round #${index + 1} · QA #${it.n}`}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {reviewedIterations.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Reviews · iteration {detail.iteration}/{detail.maxIterations}
              </p>
              <Tabs defaultValue={String(reviewedIterations[reviewedIterations.length - 1].n)}>
                {/* A single iteration needs no selector — show its report directly. */}
                {reviewedIterations.length > 1 && (
                  <TabsList>
                    {reviewedIterations.map((it) => (
                      <TabsTrigger key={it.n} value={String(it.n)}>
                        #{it.n} {it.verdict === "approved" ? "✅" : "🔄"}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                )}
                {reviewedIterations.map((it) => {
                  const body = docs[it.n]?.replace(/^---[\s\S]*?---/, "").trim();
                  return (
                    <TabsContent key={it.n} value={String(it.n)}>
                      {body ? (
                        <Dialog>
                          <DialogTrigger asChild>
                            <button
                              type="button"
                              className="group relative block max-h-36 w-full overflow-hidden rounded-lg bg-muted/50 p-3 text-left transition-colors hover:bg-muted/70"
                            >
                              <Markdown className="text-[11px] leading-snug">{body}</Markdown>
                              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-12 items-end justify-center bg-gradient-to-t from-card to-transparent">
                                <span className="mb-1 rounded-sm bg-background/80 px-2 py-0.5 text-[11px] font-medium text-muted-foreground shadow-sm group-hover:text-foreground">
                                  Click to read full report
                                </span>
                              </div>
                            </button>
                          </DialogTrigger>
                          <DialogContent className="max-h-[85vh] grid-rows-[auto_minmax(0,1fr)] sm:max-w-3xl">
                            <DialogHeader>
                              <DialogTitle>
                                Round #{index + 1} · review #{it.n} {it.verdict === "approved" ? "✅" : "🔄"}
                              </DialogTitle>
                            </DialogHeader>
                            <Markdown className="min-h-0 overflow-y-auto pr-2 text-sm">{body}</Markdown>
                          </DialogContent>
                        </Dialog>
                      ) : (
                        <div className="rounded-lg bg-muted/50 p-4">
                          <p className="text-sm text-muted-foreground">Loading review doc…</p>
                        </div>
                      )}
                    </TabsContent>
                  );
                })}
              </Tabs>
            </div>
          )}

          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">Timing</p>
            <div className="rounded-lg bg-muted/50 p-3">
              <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
                <span className="flex items-baseline gap-1.5">
                  <span className="text-xs text-muted-foreground">{timing.running ? "Elapsed" : "Total"}</span>
                  <span className="font-medium tabular-nums">{formatDurationPrecise(timing.totalMs)}</span>
                </span>
                {timing.toPrMs !== null && (
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-xs text-muted-foreground">To first PR</span>
                    <span className="font-medium tabular-nums">{formatDurationPrecise(timing.toPrMs)}</span>
                  </span>
                )}
                {timing.iterations.length > 0 && (
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-xs text-muted-foreground">Iterations</span>
                    <span className="font-medium tabular-nums">{timing.iterations.length}</span>
                  </span>
                )}
              </div>
              {timing.iterations.some((it) => it.ms !== null) && (
                <div className="mt-2.5 space-y-1 border-t pt-2.5">
                  {timing.iterations.map((it) => (
                    <div key={it.n} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">
                        Iteration #{it.n}
                        {it.verdict && (
                          <span className="ml-1.5">{it.verdict === "approved" ? "✅" : "🔄"}</span>
                        )}
                        {it.qaVerdict && (
                          <span className="ml-1.5">{it.qaVerdict === "pass" ? "QA ✅" : "QA 🔴"}</span>
                        )}
                      </span>
                      <span className="font-medium tabular-nums">
                        {it.ms !== null ? formatDurationPrecise(it.ms) : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setTimelineOpen((o) => !o)}
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {timelineOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              Timeline
              <span className="font-normal">({detail.events.length})</span>
            </button>
            {timelineOpen && (
              <div className="mt-1 space-y-0">
                {detail.events.map((event, i) => (
                  <div key={i}>
                    {i > 0 && <Separator />}
                    <div className="flex items-center justify-between py-1.5 text-sm">
                      <span className="font-mono text-xs">{event.kind}</span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(event.at).toLocaleTimeString()} · {timeAgo(event.at)}
                      </span>
                    </div>
                  </div>
                ))}
                {detail.events.length === 0 && (
                  <p className="py-1.5 text-xs text-muted-foreground">No events yet.</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
