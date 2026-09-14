import { Fragment } from "react";
import { StateBadge, stateTextClass } from "./StateBadge";
import { cn } from "@/lib/utils";
import type { ApiLoop } from "@/lib/api";
import { MessageSquare } from "lucide-react";

/**
 * The task's journey across loop rounds: round 1 → human review → round 2 → …
 * Each follow-up round exists because a human left review comments on the PR,
 * so the separator between rounds marks that review.
 */
export function RoundChain({
  rounds,
  onOpen,
}: {
  rounds: ApiLoop[];
  /** Still accepted for call-site compatibility; the chain no longer highlights it. */
  currentId?: string;
  onOpen: (id: string) => void;
}) {
  if (rounds.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {rounds.map((round, i) => {
        return (
          <Fragment key={round.id}>
            {i > 0 && (
              <span
                className="flex items-center gap-1 text-muted-foreground"
                title="Human review on the PR triggered this round"
              >
                → <MessageSquare className="size-3" /> →
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpen(round.id);
              }}
              title={`Round ${i + 1} (${round.round}) · started ${new Date(round.createdAt).toLocaleString()}`}
              className={cn(stateTextClass(round.state), "font-normal")}
            >
              {/* The whole label reads as one tinted phrase — "#1 approved" — so the
                  number and state sit in a single text flow, not two spaced elements. */}
              #{i + 1} <StateBadge state={round.state} variant="text" className="font-[inherit]" />
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
