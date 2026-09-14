import { ArrowRight, Download, FlaskConical, GitBranch, Loader2, TriangleAlert } from "lucide-react";
import { ShortcutBadge } from "./ShortcutBadge";
import type { QaRepoStatus } from "@/lib/api";

/**
 * The QA-build control for the Loop Detail right rail. Unlike the AttachmentRows
 * around it, this is not a link — it's a stateful action that checks the loop's
 * QA Companion Repo onto the Task Branch (or pulls it when already there). Set
 * apart visually (accent-tinted surface) so it reads as an action area, and
 * driven entirely by props so it can render in both the inline (narrow) and
 * sticky-rail (wide) slots from a single source of state in LoopDetail.
 *
 * Mirrors the Raycast "switch qa branch" command, scoped to one branch.
 */
export function QaBuildCard({
  status,
  busy,
  onActivate,
  shortcut,
}: {
  status: QaRepoStatus;
  busy: boolean;
  onActivate: () => void;
  /** Single-key Shift+number shortcut that fires the same action, or undefined. */
  shortcut?: string;
}) {
  const broken = Boolean(status.error);
  // The action label tracks the repo's standing: switch when elsewhere, pull
  // when behind, otherwise a cheap "up to date" re-check.
  const action = broken
    ? "QA repo unavailable"
    : busy
      ? "Working…"
      : !status.onBranch
        ? "Checkout"
        : status.unpulled > 0
          ? `Pull ${status.unpulled}`
          : "Up to date";

  const current = status.currentBranch ?? "detached HEAD";

  return (
    <button
      type="button"
      onClick={onActivate}
      disabled={busy}
      title={status.error || "Checkout or pull this loop's branch in the QA build repo"}
      className="group relative flex w-full items-start gap-3 rounded-xl bg-info-soft/40 px-3 py-3 text-left shadow-[var(--elevation)] transition-colors hover:bg-info-soft/70 disabled:cursor-not-allowed disabled:opacity-70"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background text-info">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        {/* Line 1 — title, action, unpulled chip. */}
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-medium">QA build</p>
          {broken ? (
            <TriangleAlert className="size-3.5 shrink-0 text-danger" />
          ) : (
            <span className="text-xs font-medium text-info">{action}</span>
          )}
          {!broken && status.unpulled > 0 && (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-info-soft px-1.5 py-0.5 text-[10px] font-semibold text-info">
              <Download className="size-2.5" />
              {status.unpulled}
            </span>
          )}
        </div>
        {broken ? (
          <p className="truncate text-xs text-danger">{status.error}</p>
        ) : (
          <>
            {/* Line 2 — the branch the QA repo is currently on. */}
            <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate">
                on <code className="font-mono text-foreground">{current}</code>
              </span>
            </p>
            {/* Line 3 — where we'd switch to; hidden when already on it. */}
            {!status.onBranch && (
              <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                <ArrowRight className="size-3 shrink-0" />
                <span className="truncate">
                  to <code className="font-mono text-foreground">{status.taskBranch}</code>
                </span>
              </p>
            )}
          </>
        )}
      </div>
      {shortcut && <ShortcutBadge shortcut={shortcut} compact className="absolute right-2 top-2" />}
    </button>
  );
}
