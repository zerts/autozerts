import { Card, CardContent } from "@/components/ui/card";
import { formatDuration } from "@/lib/format";
import type { Stats } from "@/lib/api";

function statItems(stats: Stats): { label: string; value: string }[] {
  // Active/queued/waiting now live in the contribution grid above; this list
  // keeps the aggregate outcome metrics.
  return [
    {
      label: "approval rate",
      value: stats.approvalRate === null ? "—" : `${Math.round(stats.approvalRate * 100)}%`,
    },
    {
      label: "avg iterations",
      value: stats.avgIterations === null ? "—" : stats.avgIterations.toFixed(1),
    },
    {
      label: "avg wall-clock",
      value: stats.avgWallClockMs === null ? "—" : formatDuration(stats.avgWallClockMs),
    },
  ];
}

/** Horizontal flex-wrap layout — used inline above the list on narrow screens. */
export function StatsBar({ stats }: { stats: Stats }) {
  return (
    <Card className="py-2">
      <CardContent className="flex flex-wrap items-center justify-around divide-x divide-border px-2">
        {statItems(stats).map((s) => (
          <div key={s.label} className="flex flex-col items-center px-4 py-1">
            <span className="text-lg font-semibold tabular-nums">{s.value}</span>
            <span className="text-xs capitalize text-muted-foreground">{s.label}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Vertical list — one stat per row (label left, value right) — for the rail. */
export function StatsList({ stats }: { stats: Stats }) {
  return (
    <Card className="py-1">
      <CardContent className="divide-y divide-border px-0">
        {statItems(stats).map((s) => (
          <div key={s.label} className="flex items-center justify-between px-3 py-2">
            <span className="text-sm capitalize text-muted-foreground">{s.label}</span>
            <span className="text-sm font-semibold tabular-nums">{s.value}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
