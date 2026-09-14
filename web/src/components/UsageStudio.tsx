import { useCallback, useEffect, useState } from "react";
import { Activity, ArrowDownLeft, ArrowUpRight, RefreshCw, X } from "lucide-react";
import { api, type ExtraUsage, type RateLimits, type RateLimitWindow, type TokenUsage, type TokenUsageWindow } from "@/lib/api";
import { formatDate, formatReset, formatTokens } from "@/lib/format";
import { cn } from "@/lib/utils";

type WindowKey = "today" | "last7Days" | "allTime";

const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "last7Days", label: "7 days" },
  { key: "allTime", label: "All time" },
];

/**
 * Floating, fixed bottom-right control that surfaces aggregated T3 Code token
 * usage plus current account rate-limit windows. Sits just above the theme
 * studio pill and shares its dev-indicator styling. Both requests fire lazily —
 * only when the popup is opened (and on manual refresh).
 */
export function UsageStudio() {
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [limits, setLimits] = useState<RateLimits | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [window_, setWindow] = useState<WindowKey>("last7Days");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.allSettled([api.usage(), api.rateLimits()])
      .then(([u, r]) => {
        if (u.status === "fulfilled") setUsage(u.value);
        else setError(u.reason instanceof Error ? u.reason.message : String(u.reason));
        if (r.status === "fulfilled") setLimits(r.value);
      })
      .finally(() => setLoading(false));
  }, []);

  // Fetch on open; close on Escape.
  useEffect(() => {
    if (!open) return;
    load();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, load]);

  const w = usage?.[window_];

  return (
    <div className="relative">
      {/* Transparent catch-all to dismiss on outside click while open. */}
      {open && <div className="fixed inset-0 -z-10" onClick={() => setOpen(false)} aria-hidden />}

      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-64 origin-bottom-right overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-[var(--elevation)]">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold tracking-tight">
              <Activity className="size-3.5 text-primary" /> Cloud usage
            </span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={load}
                disabled={loading}
                aria-label="Refresh usage"
                className="rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
              >
                <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close cloud usage"
                className="rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </div>

          <div className="p-2">
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-secondary/60 p-1">
              {WINDOWS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setWindow(key)}
                  className={cn(
                    "rounded-md py-1.5 text-[10px] font-medium transition-colors",
                    window_ === key
                      ? "bg-background text-foreground shadow-[var(--elevation)]"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="mt-2 min-h-[7.5rem]">
              {error ? (
                <p className="px-1 py-6 text-center text-[11px] text-muted-foreground">{error}</p>
              ) : loading && !usage ? (
                <p className="px-1 py-6 text-center text-[11px] text-muted-foreground">Loading…</p>
              ) : w ? (
                <UsagePanel window={w} />
              ) : null}
            </div>
          </div>

          {limits && (
            <div className="border-t p-2">
              <p className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Usage limits
              </p>
              {limits.available ? (
                <div className="space-y-1.5">
                  {limits.windows.map((lw) => (
                    <LimitRow key={lw.kind + (lw.scopeModel ?? "")} window={lw} />
                  ))}
                  {limits.extra && limits.extra.utilization > 0 && <ExtraRow extra={limits.extra} />}
                </div>
              ) : (
                <p className="px-1 py-3 text-center text-[11px] text-muted-foreground">{limits.reason}</p>
              )}
            </div>
          )}

          {usage && (
            <div className="border-t px-3 py-2 text-[10px] text-muted-foreground">
              {usage.threads.toLocaleString()} {usage.threads === 1 ? "thread" : "threads"}
              {usage.since && <> · since {formatDate(usage.since)}</>}
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Cloud usage"
        aria-label="Open cloud usage"
        aria-expanded={open}
        className="flex items-center justify-center rounded-full bg-popover/90 p-2 text-foreground shadow-[var(--elevation)] backdrop-blur transition-colors hover:bg-popover"
      >
        <Activity className="size-4 text-primary" />
      </button>
    </div>
  );
}

function UsagePanel({ window }: { window: TokenUsageWindow }) {
  const total = window.inputTokens + window.outputTokens;
  return (
    <div className="space-y-2 px-1 pt-1">
      <div className="text-center">
        <div className="text-2xl font-semibold leading-none tracking-tight tabular-nums">
          {formatTokens(total)}
        </div>
        <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          tokens · {window.turns.toLocaleString()} {window.turns === 1 ? "turn" : "turns"}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Stat icon={ArrowDownLeft} label="Input" value={window.inputTokens} hint="includes cached tokens" />
        <Stat icon={ArrowUpRight} label="Output" value={window.outputTokens} />
      </div>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof ArrowDownLeft;
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <div className="rounded-lg bg-secondary/60 px-2.5 py-2" title={hint}>
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3" /> {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{formatTokens(value)}</div>
    </div>
  );
}

function windowLabel(w: RateLimitWindow): string {
  switch (w.kind) {
    case "session":
      return "Current session";
    case "weekly_all":
      return "Current week";
    case "weekly_scoped":
      return `Current week (${w.scopeModel ?? "scoped"})`;
    default:
      return w.kind.replace(/_/g, " ");
  }
}

/** Bar/percent colour escalates with severity, then with how full the window is. */
function usageTone(percent: number, severity: string): string {
  if (severity === "critical" || severity === "blocked" || percent >= 95) return "bg-destructive";
  if (severity === "warning" || percent >= 80) return "bg-amber-500";
  return "bg-primary";
}

function Meter({ percent, tone, label, right }: { percent: number; tone: string; label: string; right?: string }) {
  return (
    <div className="rounded-lg bg-secondary/60 px-2.5 py-2">
      <div className="flex items-center justify-between text-xs font-medium">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">{Math.round(percent)}%</span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </div>
      {right && <div className="mt-1 text-right text-[10px] text-muted-foreground">{right}</div>}
    </div>
  );
}

function LimitRow({ window }: { window: RateLimitWindow }) {
  return (
    <Meter
      label={windowLabel(window)}
      percent={window.percent}
      tone={usageTone(window.percent, window.severity)}
      right={window.resetsAt ? `resets ${formatReset(window.resetsAt)}` : undefined}
    />
  );
}

function ExtraRow({ extra }: { extra: ExtraUsage }) {
  const div = 10 ** extra.decimalPlaces;
  const used = (extra.usedCredits / div).toFixed(extra.decimalPlaces);
  const cap = (extra.monthlyLimit / div).toFixed(0);
  return (
    <Meter
      label="Extra usage"
      percent={extra.utilization}
      tone={usageTone(extra.utilization, "normal")}
      right={`$${used} / $${cap} ${extra.currency}`}
    />
  );
}
