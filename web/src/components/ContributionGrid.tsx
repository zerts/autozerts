import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import type { ApiLoop } from "@/lib/api";

const CELL = 11; // px, square cell
const GAP = 3; // px, gap between columns
const MIN_WEEKS = 13; // ~3 months, the floor when the container is narrow
const MAX_WEEKS = 53; // ~1 year, the most history we keep

interface Cell {
  key: string;
  date: Date;
  count: number;
  /** Days past today: rendered as an empty placeholder to keep columns aligned. */
  future: boolean;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Local YYYY-MM-DD — the bucket key for a day (timezone-stable, unlike toISOString). */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 0–4 intensity bucket for a day's approved count, GitHub-style. */
function level(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 5) return 3;
  return 4;
}

const LEVEL_CLASS = [
  "bg-muted",
  "bg-emerald-200 dark:bg-emerald-900",
  "bg-emerald-300 dark:bg-emerald-700",
  "bg-emerald-400 dark:bg-emerald-600",
  "bg-emerald-500 dark:bg-emerald-400",
];

/**
 * GitHub-style contribution heatmap of approved loops per day. Columns are weeks
 * (Mon→Sun), the rightmost being the current week. The number of week-columns is
 * responsive: it packs in as many as the card is wide enough to show (clamped to
 * {@link MIN_WEEKS}…{@link MAX_WEEKS}) so no horizontal space is wasted. Counts
 * every approved loop on the local day it went terminal — a task reviewed across
 * multiple rounds contributes once per approved round.
 */
export function ContributionGrid({ loops }: { loops: ApiLoop[] }) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [weekCount, setWeekCount] = useState(MIN_WEEKS);

  // Fit as many week-columns as the available width allows. Each column occupies
  // CELL px plus a GAP, except the last which needs no trailing gap.
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w <= 0) return;
      const fit = Math.floor((w + GAP) / (CELL + GAP));
      setWeekCount(Math.max(MIN_WEEKS, Math.min(MAX_WEEKS, fit)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { weeks, total, months } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of loops) {
      if (l.state !== "approved" || !l.terminalAt) continue;
      const k = dayKey(new Date(l.terminalAt));
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }

    const today = startOfDay(new Date());
    // Days since the Monday that starts this week (Mon=0 … Sun=6).
    const sinceMonday = (today.getDay() + 6) % 7;
    // First cell = the Monday that starts the column weekCount-1 weeks before this
    // one. Use setDate (not ms math) so DST transitions don't shift the day.
    const start = startOfDay(new Date(today));
    start.setDate(start.getDate() - (sinceMonday + (weekCount - 1) * 7));

    let total = 0;
    const weeks: Cell[][] = [];
    const cursor = new Date(start);
    for (let w = 0; w < weekCount; w++) {
      const col: Cell[] = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(cursor);
        const future = date.getTime() > today.getTime();
        const count = future ? 0 : counts.get(dayKey(date)) ?? 0;
        total += count;
        col.push({ key: dayKey(date), date, count, future });
        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push(col);
    }
    // How many whole months the span roughly covers, for the header label.
    const months = Math.max(1, Math.round(weekCount / (52 / 12)));
    return { weeks, total, months };
  }, [loops, weekCount]);

  // Month label above the first column of each month (overflows right, GitHub-style).
  const monthLabels = weeks.map((col, i) => {
    const month = col[0].date.getMonth();
    const prev = i > 0 ? weeks[i - 1][0].date.getMonth() : -1;
    return month !== prev ? col[0].date.toLocaleDateString(undefined, { month: "short" }) : "";
  });

  return (
    <Card className="py-3">
      <CardContent className="space-y-2 px-3">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{total} approved · last {months} {months === 1 ? "month" : "months"}</span>
        </div>
        <div ref={gridRef} className="overflow-x-auto">
          <div className="inline-flex flex-col gap-1">
            <div className="flex gap-[3px] text-[9px] leading-none text-muted-foreground">
              {monthLabels.map((label, i) => (
                <div key={i} className="w-[11px] shrink-0 overflow-visible whitespace-nowrap">
                  {label}
                </div>
              ))}
            </div>
            {/* Native `title` tooltips instead of a Radix Tooltip per cell: a year
                of cells is ~370 of them, and the extra DOM + React fibers made the
                whole dashboard (and its re-renders) measurably heavier. */}
            <div className="flex gap-[3px]">
              {weeks.map((col, i) => (
                <div key={i} className="flex flex-col gap-[3px]">
                  {col.map((cell) =>
                    cell.future ? (
                      <div key={cell.key} className="size-[11px]" />
                    ) : (
                      <div
                        key={cell.key}
                        title={`${cell.count} approved · ${formatDate(cell.date.toISOString())}`}
                        className={`size-[11px] rounded-[2px] ${LEVEL_CLASS[level(cell.count)]}`}
                      />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
          <span>Less</span>
          {LEVEL_CLASS.map((cls, i) => (
            <div key={i} className={`size-[11px] rounded-[2px] ${cls}`} />
          ))}
          <span>More</span>
        </div>
      </CardContent>
    </Card>
  );
}
