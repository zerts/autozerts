import { useState } from "react";
import { ChevronDown, ChevronRight, Check, MessageSquare, Sparkles } from "lucide-react";
import type { ReviewThread } from "@/lib/api";
import { Markdown } from "@/components/Markdown";
import { cn } from "@/lib/utils";

/**
 * A human-review entry in the loop feed. Sits between two rounds — the human
 * left PR comments, which triggered the next (address-review) round. Expands
 * into the full dialogue: every review thread with its comment chain, resolved
 * threads marked as addressed along the way.
 */
export function HumanReview({ threads }: { threads: ReviewThread[] }) {
  const [open, setOpen] = useState(false);
  const resolved = threads.filter((t) => t.isResolved).length;

  return (
    // Same tray shell as RoundSection, in the warning palette: the dashed strip is
    // a recessed backdrop, and the expanded dialogue sits on an elevated panel with
    // a rounded top edge and a shadow cast upward onto the strip.
    <div className="mx-auto w-full max-w-[calc(100%-2rem)]">
      <div className="relative isolate overflow-hidden rounded-xl border border-dashed border-warning/40 bg-warning-soft/40 shadow-[var(--elevation)]">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors",
            // Collapsed: the strip is the whole card, so give it a solid warning
            // surface. Expanded: it recedes behind the elevated content panel.
            open ? "hover:bg-warning-soft/60" : "bg-warning-soft/60 hover:bg-warning-soft/80",
          )}
        >
          {open ? <ChevronDown className="size-4 text-warning" /> : <ChevronRight className="size-4 text-warning" />}
          <MessageSquare className="size-4 text-warning" />
          <span className="text-sm font-medium text-foreground">Human review on the PR</span>
          {threads.length > 0 && (
            <span className="ml-auto text-xs text-warning">
              {threads.length} {threads.length === 1 ? "thread" : "threads"}
              {resolved > 0 && ` · ${resolved} addressed`}
            </span>
          )}
        </button>

        {open && (
          <div
            className="relative z-10 space-y-2 rounded-t-xl border-t border-warning/20 bg-card px-4 py-3"
            style={{ boxShadow: "0 -8px 18px -6px var(--shadow-color), 0 -2px 6px -3px var(--shadow-color)" }}
          >
            {threads.length === 0 && (
              <p className="text-sm text-muted-foreground">No review threads found on the PR.</p>
            )}
            {threads.map((thread, i) => (
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
                  <span
                    className={cn(
                      "ml-auto flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium",
                      thread.isResolved
                        ? "bg-success-soft text-success"
                        : "bg-warning-soft text-warning",
                    )}
                  >
                    {thread.isResolved && <Check className="size-3" />}
                    {thread.isResolved ? "addressed" : "open"}
                  </span>
                </div>
                {thread.comments.map((comment, j) => {
                  // The top comment is the human's review remark; every reply
                  // below it is written by the AI through the user's token, so
                  // it carries the same login — don't attribute it to a person.
                  const isReply = j > 0;
                  return (
                    <div
                      key={j}
                      className={cn(
                        "mt-1.5 text-sm",
                        isReply && "border-l-2 border-special/40 pl-3",
                      )}
                    >
                      {isReply ? (
                        <span className="inline-flex items-center gap-1 rounded-sm bg-special-soft px-1.5 py-0.5 text-[10px] font-semibold text-special">
                          <Sparkles className="size-3" />
                          AI reply
                        </span>
                      ) : (
                        <span className="text-xs font-semibold text-muted-foreground">{comment.author}</span>
                      )}
                      <Markdown className="mt-0.5 text-sm">{comment.body}</Markdown>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
