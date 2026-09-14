import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight, ExternalLink, PartyPopper, Search } from "lucide-react";
import { AttachmentRow } from "@/components/AttachmentRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { StateBadge } from "@/components/StateBadge";
import { ProjectCard } from "@/components/ProjectCard";
import { api, type ApiIssue, type ApiLoop, type Health, type ReviewThread } from "@/lib/api";
import { displayTitle, timeAgo } from "@/lib/format";

/** Review-model value meaning "reuse the implementation model" (Radix Select disallows ""). */
const INHERIT = "inherit";

const SECTION_ORDER: Array<{ title: string; types: string[]; collapsible?: boolean }> = [
  { title: "Todo", types: ["unstarted"] },
  { title: "Backlog", types: ["backlog"] },
  { title: "Triage", types: ["triage"], collapsible: true },
  { title: "In Progress", types: ["started"], collapsible: true },
];

function IssueRow({ issue, onSelect }: { issue: ApiIssue; onSelect: (issue: ApiIssue) => void }) {
  return (
    <ProjectCard
      repo={issue.defaultRepo ?? undefined}
      iconUrl={issue.iconUrl}
      accent={issue.gradient}
      onClick={() => onSelect(issue)}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground">{issue.identifier}</span>
            {issue.loop && <StateBadge state={issue.loop.state} />}
            {issue.labels.includes("AI-Ready") && (
              <span className="rounded-sm bg-info-soft px-1.5 py-0.5 text-[10px] font-medium text-info">AI-Ready</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-sm font-medium">{displayTitle(issue.title, issue.titlePrefix)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3 transition-transform duration-300 ease-out group-hover:-translate-x-[5px] motion-reduce:transition-none motion-reduce:group-hover:translate-x-0">
          <span className="text-xs text-muted-foreground">{timeAgo(issue.updatedAt)}</span>
          <a
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title="Open in Linear"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      </div>
    </ProjectCard>
  );
}

/** A cheerful placeholder for an empty "Todo" section — nothing queued up is
 *  good news, so we say so rather than leaving a blank gap. */
function TodoEmptyState() {
  return (
    <Card className="border border-dashed bg-transparent shadow-none">
      <CardContent className="flex flex-col items-center gap-2 px-6 py-10 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-success-soft text-success">
          <PartyPopper className="size-5" />
        </span>
        <p className="text-sm font-medium">You're all caught up!</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Nothing waiting in To&nbsp;Do. Pull something from Backlog when you're ready. ✨
        </p>
      </CardContent>
    </Card>
  );
}

/** A task section. When `collapsible`, it folds behind a click-to-expand header
 *  (collapsed by default) — mirroring the older-loops section on the dashboard.
 *  `emptyState` renders in place of the rows when there are no issues. */
function TaskSection({
  title,
  issues,
  collapsible,
  emptyState,
  onSelect,
}: {
  title: string;
  issues: ApiIssue[];
  collapsible?: boolean;
  emptyState?: ReactNode;
  onSelect: (issue: ApiIssue) => void;
}) {
  const [open, setOpen] = useState(false);
  const rows =
    issues.length === 0 && emptyState ? (
      emptyState
    ) : (
      <div className="space-y-2">
        {issues.map((issue) => (
          <IssueRow key={issue.id} issue={issue} onSelect={onSelect} />
        ))}
      </div>
    );
  if (!collapsible) {
    return (
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
        {rows}
      </section>
    );
  }
  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 text-sm font-semibold text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={`size-4 transition-transform ${open ? "rotate-90" : ""}`} />
        {title}
        <span className="text-muted-foreground/60">({issues.length})</span>
      </button>
      {open && rows}
    </section>
  );
}

export function Tasks({
  health,
  onLoopOpened,
}: {
  health: Health | null;
  onLoopOpened: (loopId: string) => void;
}) {
  const [issues, setIssues] = useState<ApiIssue[] | null>(null);
  const [selected, setSelected] = useState<ApiIssue | null>(null);
  const [arPrompt, setArPrompt] = useState<{ issue: ApiIssue; loop: ApiLoop; threads: ReviewThread[] } | null>(null);
  const [repo, setRepo] = useState<string>("");
  const [extras, setExtras] = useState("");
  const [autonomous, setAutonomous] = useState(false);
  const [forceGrill, setForceGrill] = useState(false);
  const [model, setModel] = useState<string>("");
  const [reviewModel, setReviewModel] = useState<string>(INHERIT);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useMemo(() => {
    api.issues().then(setIssues).catch((e) => setError(String(e)));
  }, []);

  const sections = useMemo(() => {
    if (!issues) return [];
    const q = query.trim().toLowerCase();
    const matches = issues.filter((i) => {
      if (q && !(i.identifier.toLowerCase().includes(q) || i.title.toLowerCase().includes(q))) return false;
      return true;
    });
    return SECTION_ORDER.map(({ title, types, collapsible }) => ({
      title,
      collapsible,
      issues: matches
        .filter((i) => types.includes(i.state.type))
        .sort((a, b) => Number(b.labels.includes("AI-Ready")) - Number(a.labels.includes("AI-Ready"))),
      // Keep Todo around even when empty so it can show its cheerful empty state —
      // but only when a search is active (otherwise it'd contradict the
      // "no matches" message and read as misleading).
    })).filter((s) => s.issues.length > 0 || (s.title === "Todo" && q.length === 0));
  }, [issues, query]);

  // Quick insights drawn straight from the loaded issue list — no extra fetch.
  const overview = useMemo(() => {
    const list = issues ?? [];
    const count = (types: string[]) => list.filter((i) => types.includes(i.state.type)).length;
    return [
      { label: "In Progress", value: count(["started"]) },
      { label: "Todo", value: count(["unstarted"]) },
      { label: "Backlog", value: count(["backlog", "triage"]) },
      { label: "AI-Ready", value: list.filter((i) => i.labels.includes("AI-Ready")).length },
      { label: "With loop", value: list.filter((i) => i.loop).length },
    ];
  }, [issues]);

  // The workspace slug is the same for every issue, so derive the "My Issues"
  // deep-link from the first issue URL (https://linear.app/<workspace>/…).
  const linearMyIssuesUrl = useMemo(() => {
    const url = issues?.find((i) => i.url)?.url;
    const match = url?.match(/^(https:\/\/linear\.app\/[^/]+)\//);
    return match ? `${match[1]}/my-issues` : null;
  }, [issues]);

  function handleSelect(issue: ApiIssue) {
    // Existing loop (active or resumable) → the select endpoint decides; no form.
    if (issue.loop) {
      setBusy(true);
      api
        .select(issue.identifier, {})
        .then((res) => {
          if (res.action === "address-review-available") {
            // Finished loop + open PR: confirm before burning a round.
            setArPrompt({ issue, loop: res.loop, threads: res.unresolvedThreads ?? [] });
          } else {
            onLoopOpened(res.loop.id);
          }
        })
        .catch((e) => setError(String(e)))
        .finally(() => setBusy(false));
      return;
    }
    setSelected(issue);
    setRepo(issue.defaultRepo ?? health?.repos[0] ?? "");
    setExtras("");
    setAutonomous(false);
    setForceGrill(false);
    const offered = health?.models ?? [];
    // Default to the config model when it's one we offer; else the latest (first).
    setModel(offered.some((m) => m.id === health?.defaultModel) ? health!.defaultModel : offered[0]?.id ?? "");
    setReviewModel(INHERIT);
  }

  function modelArgs() {
    return {
      model: model || undefined,
      reviewModel: reviewModel === INHERIT ? undefined : reviewModel,
    };
  }

  function startLoop() {
    if (!selected) return;
    setBusy(true);
    api
      .select(selected.identifier, { repo, extras: extras || undefined, autonomous, forceGrill, ...modelArgs() })
      .then((res) => {
        setSelected(null);
        onLoopOpened(res.loop.id);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  }

  function startAddressReview() {
    if (!arPrompt) return;
    setBusy(true);
    api
      .addressReview(arPrompt.issue.identifier)
      .then((res) => {
        setArPrompt(null);
        onLoopOpened(res.loop.id);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  }

  const filtersActive = query.trim().length > 0;
  const loading = !issues && !error;

  // The search, filters, insights, and Linear link render in two places — inline
  // above the list on narrow screens, and as a sticky right rail on wide screens.
  // The rail renders while issues load too; only the stat numbers wait for data.
  const rail = (
    <>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tasks by ID or title…"
          className="rounded-xl bg-card pl-9"
        />
      </div>
      <Card className="py-1">
        <CardContent className="divide-y divide-border px-0">
          {overview.map((s) => (
            <div key={s.label} className="flex items-center justify-between px-3 py-2">
              <span className="text-sm text-muted-foreground">{s.label}</span>
              {!loading && <span className="text-sm font-semibold tabular-nums">{s.value}</span>}
            </div>
          ))}
        </CardContent>
      </Card>
      {linearMyIssuesUrl && (
        <AttachmentRow icon={ExternalLink} title="My Linear issues" subtitle="Open in Linear" href={linearMyIssuesUrl} />
      )}
    </>
  );

  return (
    <div className="space-y-6">
      {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
      {(issues || loading) && (
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6">
          <div className="space-y-6 lg:min-w-0">
            {/* Narrow screens: search + filters + insights stack inline up top. */}
            <div className="space-y-4 lg:hidden">{rail}</div>
            {!loading && sections.length === 0 && (
              <p className="py-16 text-center text-sm text-muted-foreground">
                {filtersActive ? "No tasks match the current filters." : "No tasks."}
              </p>
            )}
            {sections.map((section) => (
              <TaskSection
                key={section.title}
                title={section.title}
                issues={section.issues}
                collapsible={section.collapsible}
                emptyState={section.title === "Todo" ? <TodoEmptyState /> : undefined}
                onSelect={handleSelect}
              />
            ))}
          </div>

          {/* Wide screens: search + filters + insights become a sticky right rail.
              The "Filter" heading mirrors the section headings on the left so the
              rail's first item lines up with the first task card. */}
          <aside className="hidden lg:block lg:sticky lg:top-18">
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Filter</h2>
            <div className="flex flex-col gap-4">{rail}</div>
          </aside>
        </div>
      )}

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Start loop — {selected?.identifier}
            </DialogTitle>
            <DialogDescription className="truncate">{selected?.title}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Repository</Label>
              <Select value={repo} onValueChange={setRepo}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick a repo" />
                </SelectTrigger>
                <SelectContent>
                  {(health?.repos ?? []).map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Implementation model</Label>
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Pick a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {(health?.models ?? []).map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Review model</Label>
                <Select value={reviewModel} onValueChange={setReviewModel}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>Same as implementation</SelectItem>
                    {(health?.models ?? []).map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Extra instructions (optional)</Label>
              <Textarea value={extras} onChange={(e) => setExtras(e.target.value)} rows={3} />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="autonomous" className="font-normal">
                Autonomous — don't grill, record assumptions in the PR
              </Label>
              <Switch id="autonomous" checked={autonomous} onCheckedChange={setAutonomous} />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="grill" className="font-normal">
                Force grill — start with /grill-with-docs
              </Label>
              <Switch id="grill" checked={forceGrill} onCheckedChange={setForceGrill} />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button disabled={busy || !repo} onClick={startLoop}>
              Start loop
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={arPrompt !== null} onOpenChange={(open) => !open && setArPrompt(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Address review — {arPrompt?.issue.identifier}</DialogTitle>
            <DialogDescription>
              The loop finished and{" "}
              {arPrompt?.loop.pr?.url ? (
                <a href={arPrompt.loop.pr.url} target="_blank" rel="noreferrer" className="underline">
                  PR #{arPrompt.loop.pr.number}
                </a>
              ) : (
                "the PR"
              )}{" "}
              is still open. Unresolved review threads:
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {arPrompt?.threads.length === 0 && (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No unresolved review threads on the PR.
              </p>
            )}
            {arPrompt?.threads.map((thread, i) => (
              <div key={i} className="rounded-md bg-muted/30 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="truncate font-mono">
                    {thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ""}` : "(general)"}
                  </span>
                  {thread.isOutdated && <span className="shrink-0 rounded-sm bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning">outdated</span>}
                </div>
                {thread.comments.map((comment, j) => (
                  <p key={j} className="mt-1 text-sm whitespace-pre-wrap">
                    <span className="font-semibold">{comment.author}</span> {comment.body}
                  </p>
                ))}
              </div>
            ))}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setArPrompt(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={startAddressReview}>
              Start address-review round
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
