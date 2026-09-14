import type { LucideIcon } from "lucide-react";
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PrStatus } from "@/lib/api";

/** Per-lifecycle label, icon, and badge tint — shared by the badge and the card. */
export const PR_STATE_META: Record<PrStatus["state"], { label: string; icon: LucideIcon; badge: string; tint: string }> = {
  open: { label: "Open", icon: GitPullRequest, badge: "bg-success-soft text-success", tint: "text-success" },
  draft: { label: "Draft", icon: GitPullRequestDraft, badge: "bg-muted text-muted-foreground", tint: "text-muted-foreground" },
  merged: { label: "Merged", icon: GitMerge, badge: "bg-special-soft text-special", tint: "text-special" },
  closed: { label: "Closed", icon: GitPullRequestClosed, badge: "bg-danger-soft text-danger", tint: "text-danger" },
};

/** CI rollup → the colour of the little check dot. */
export const PR_CHECK_DOT: Record<NonNullable<PrStatus["checks"]>, string> = {
  passing: "bg-success",
  failing: "bg-danger",
  pending: "bg-warning",
};

/** One-line description for tooltips: "Open · checks passing". */
export function prStatusTitle(status: PrStatus, prNumber?: number): string {
  const lifecycle = `${prNumber ? `PR #${prNumber} · ` : ""}${PR_STATE_META[status.state].label}`;
  return status.checks ? `${lifecycle} · checks ${status.checks}` : lifecycle;
}

/** Icon-only status indicator (lifecycle icon, tinted) with the full status as a tooltip. */
export function PrStatusIcon({ status, className }: { status: PrStatus; className?: string }) {
  const meta = PR_STATE_META[status.state];
  const Icon = meta.icon;
  return (
    <span title={prStatusTitle(status)} className={cn("inline-flex shrink-0", meta.tint, className)}>
      <Icon className="size-4" />
    </span>
  );
}

export function PrStatusBadge({ status, className }: { status: PrStatus; className?: string }) {
  const meta = PR_STATE_META[status.state];
  const Icon = meta.icon;
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 font-medium", meta.badge, className)}
      title={prStatusTitle(status)}
    >
      <Icon className="size-3" />
      {meta.label}
      {status.checks && status.state !== "merged" && status.state !== "closed" && (
        <span className={cn("ml-0.5 size-1.5 rounded-full", PR_CHECK_DOT[status.checks])} />
      )}
    </Badge>
  );
}
