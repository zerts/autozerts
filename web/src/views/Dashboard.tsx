import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ContributionGrid } from "@/components/ContributionGrid";
import { LoopCard } from "@/components/LoopCard";
import { RepoLinks } from "@/components/RepoLinks";
import { digitForIndex, indexForCode, isTypingTarget } from "@/lib/shortcuts";
import type { ApiLoop, Health, PrStatus } from "@/lib/api";

const ACTIVE_STATES = ["running", "blocked", "paused", "queued"] as const;
const WEEK_MS = 7 * 24 * 60 * 60_000;

/** A terminal loop counts as "old" once it finished more than a week ago. */
function finishedOverAWeekAgo(loop: ApiLoop): boolean {
  if (!loop.terminalAt) return false;
  return Date.now() - new Date(loop.terminalAt).getTime() > WEEK_MS;
}

/** Whether the loop finished (or, lacking a terminal time, last moved) today. */
function finishedToday(loop: ApiLoop): boolean {
  const iso = loop.terminalAt ?? loop.updatedAt;
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/** One entry per task: its latest loop plus the full round chain (oldest first). */
interface LoopGroup {
  latest: ApiLoop;
  rounds: ApiLoop[];
}

function groupByIssue(loops: ApiLoop[]): LoopGroup[] {
  const byIssue = new Map<string, ApiLoop[]>();
  for (const loop of loops) {
    const group = byIssue.get(loop.issue.id);
    if (group) group.push(loop);
    else byIssue.set(loop.issue.id, [loop]);
  }
  // /api/loops is newest-first, so g[0] is the latest round and the reverse
  // is the chronological chain.
  return [...byIssue.values()].map((g) => ({ latest: g[0], rounds: [...g].reverse() }));
}

function Section({
  title,
  groups,
  prStatuses,
  onOpen,
  shortcuts,
}: {
  title: string;
  groups: LoopGroup[];
  prStatuses: Record<string, PrStatus>;
  onOpen: (id: string) => void;
  shortcuts: Map<string, string>;
}) {
  if (groups.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
      <div className="space-y-2">
        {groups.map((group) => (
          <LoopCard
            key={group.latest.id}
            loop={group.latest}
            rounds={group.rounds}
            prStatus={prStatuses[group.latest.id]}
            onOpen={onOpen}
            shortcut={shortcuts.get(group.latest.id)}
          />
        ))}
      </div>
    </section>
  );
}

/** Like Section, but folded behind a click-to-expand header (collapsed by default). */
function CollapsibleSection({
  title,
  groups,
  prStatuses,
  onOpen,
}: {
  title: string;
  groups: LoopGroup[];
  prStatuses: Record<string, PrStatus>;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (groups.length === 0) return null;
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
        <span className="text-muted-foreground/60">({groups.length})</span>
      </button>
      {open && (
        <div className="space-y-2">
          {groups.map((group) => (
            <LoopCard
              key={group.latest.id}
              loop={group.latest}
              rounds={group.rounds}
              prStatus={prStatuses[group.latest.id]}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function Dashboard({
  loops,
  prStatuses,
  health,
  onOpen,
}: {
  loops: ApiLoop[];
  prStatuses: Record<string, PrStatus>;
  health: Health | null;
  onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState("");

  const allGroups = useMemo(() => groupByIssue(loops), [loops]);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allGroups;
    return allGroups.filter(
      (g) =>
        g.latest.issue.identifier.toLowerCase().includes(q) ||
        g.latest.issue.title.toLowerCase().includes(q),
    );
  }, [allGroups, query]);
  const active = groups.filter((g) => ACTIVE_STATES.includes(g.latest.state as never));
  const terminal = groups.filter((g) => !ACTIVE_STATES.includes(g.latest.state as never));
  // Split the terminal loops into three buckets: finished today, finished within
  // the last week, and anything older (which folds into a collapsed section).
  const recent = terminal.filter((g) => !finishedOverAWeekAgo(g.latest));
  const older = terminal.filter((g) => finishedOverAWeekAgo(g.latest));
  const today = recent.filter((g) => finishedToday(g.latest));
  const lastWeek = recent.filter((g) => !finishedToday(g.latest));

  // Sections render top-to-bottom in this order; flatten them the same way to
  // hand the first ten loops a single-key jump shortcut (1–9, then 0).
  const sections = [
    { title: "Waiting", groups: active.filter((g) => g.latest.state === "blocked") },
    { title: "Running", groups: active.filter((g) => g.latest.state === "running") },
    { title: "Paused", groups: active.filter((g) => g.latest.state === "paused") },
    { title: "Queued", groups: active.filter((g) => g.latest.state === "queued") },
    { title: "Today", groups: today },
    { title: "Last 7 days", groups: lastWeek },
  ];

  const orderedIds = sections.flatMap((s) => s.groups.map((g) => g.latest.id)).slice(0, 10);
  const shortcuts = new Map(orderedIds.map((id, i) => [id, digitForIndex(i)!]));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const index = indexForCode(e.code);
      const id = index >= 0 ? orderedIds[index] : undefined;
      if (id) {
        e.preventDefault();
        onOpen(id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [orderedIds.join(","), onOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const search = (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search loops by ID or title…"
        className="rounded-xl bg-card pl-9"
      />
    </div>
  );

  const noMatches = loops.length > 0 && groups.length === 0;

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6">
      <div className="space-y-6 lg:min-w-0">
        {/* Narrow screens: just the search above the list — the activity grid
            and stats live in the wide-screen rail only. */}
        <div className="lg:hidden">{search}</div>
        {loops.length === 0 && (
          <p className="py-16 text-center text-sm text-muted-foreground">
            No loops yet — pick a task in the Tasks tab to start one.
          </p>
        )}
        {noMatches && (
          <p className="py-16 text-center text-sm text-muted-foreground">
            No loops match “{query.trim()}”.
          </p>
        )}
        {sections.map((s) => (
          <Section key={s.title} title={s.title} groups={s.groups} prStatuses={prStatuses} onOpen={onOpen} shortcuts={shortcuts} />
        ))}
        <CollapsibleSection title="Finished over a week ago" groups={older} prStatuses={prStatuses} onOpen={onOpen} />
      </div>

      {/* Wide screens: search + stats become a sticky right rail, one stat per
          row, with repo quick links beneath them. */}
      <aside className="hidden space-y-4 lg:block lg:sticky lg:top-18">
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">Search</h2>
          {search}
        </div>
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">Activity</h2>
          <ContributionGrid loops={loops} />
        </div>
        <RepoLinks repos={health?.repoLinks ?? []} />
      </aside>
    </div>
  );
}
