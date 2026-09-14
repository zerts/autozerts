import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { LoopState } from "@/lib/api";

const STYLES: Record<LoopState, string> = {
  running: "bg-info-soft text-info",
  queued: "bg-muted text-muted-foreground",
  blocked: "bg-warning-soft text-warning",
  paused: "bg-special-soft text-special",
  approved: "bg-success-soft text-success",
  exhausted: "bg-danger-soft text-danger",
  cancelled: "bg-muted text-muted-foreground/70",
  error: "bg-danger-soft text-danger",
};

// Text-only tints (no pill background/border), for when the badge already sits
// inside another pill and a nested pill would look heavy.
const TEXT_STYLES: Record<LoopState, string> = {
  running: "text-info",
  queued: "text-muted-foreground",
  blocked: "text-warning",
  paused: "text-special",
  approved: "text-success",
  exhausted: "text-danger",
  cancelled: "text-muted-foreground/70",
  error: "text-danger",
};

/** The text-color class for a state, for tinting text outside a StateBadge. */
export function stateTextClass(state: LoopState) {
  return TEXT_STYLES[state];
}

// `blocked` is never a hard failure here — it always means the loop is waiting
// on the human (grill answers, a pushed branch, an approval). Label it as such.
const LABELS: Partial<Record<LoopState, string>> = {
  blocked: "waiting",
};

export function StateBadge({
  state,
  variant = "badge",
  className,
}: {
  state: LoopState;
  variant?: "badge" | "text";
  className?: string;
}) {
  const label = LABELS[state] ?? state;
  if (variant === "text") {
    return <span className={cn("font-medium", TEXT_STYLES[state], className)}>{label}</span>;
  }
  return (
    <Badge variant="outline" className={cn("font-medium", STYLES[state], className)}>
      {label}
    </Badge>
  );
}
