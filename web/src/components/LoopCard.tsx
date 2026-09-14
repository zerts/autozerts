import { memo } from "react";
import { StateBadge } from "./StateBadge";
import { RoundChain } from "./RoundChain";
import { ProjectCard } from "./ProjectCard";
import { ShortcutBadge } from "./ShortcutBadge";
import { PR_STATE_META, PrStatusBadge, prStatusTitle } from "./PrStatusBadge";
import { displayTitle, loopActivity, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ApiLoop, PrStatus } from "@/lib/api";
import { ExternalLink, GitPullRequest, Globe, Terminal } from "lucide-react";

export const LoopCard = memo(function LoopCard({
  loop,
  rounds,
  prStatus,
  onOpen,
  shortcut,
}: {
  loop: ApiLoop;
  /** The task's full round chain (oldest first) — rendered as a timeline when there is more than one round. */
  rounds?: ApiLoop[];
  /** Live status of the loop's PR, when it has one — drives the badge + icon tint. */
  prStatus?: PrStatus;
  onOpen: (id: string) => void;
  /** Single-key jump shortcut (1–9, 0) for the first loops on the dashboard. */
  shortcut?: string;
}) {
  // The right-side PR icon doubles as a status indicator: it takes the lifecycle
  // icon + colour once the live status has loaded.
  const PrIcon = prStatus ? PR_STATE_META[prStatus.state].icon : GitPullRequest;
  return (
    <ProjectCard repo={loop.repo} iconUrl={loop.iconUrl} accent={loop.gradient} onClick={() => onOpen(loop.id)}>
      <div className="flex items-center gap-3 px-4 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground">{loop.issue.identifier}</span>
            {/* `approved` is the quiet "done" state — the PR badge below and the
                round chain already carry it, so we suppress it here to cut noise.
                Every other state (running, waiting, exhausted, error) still shows. */}
            {loop.state !== "approved" && <StateBadge state={loop.state} />}
            {prStatus && <PrStatusBadge status={prStatus} />}
            {shortcut && <ShortcutBadge shortcut={shortcut} compact />}
          </div>
          <p className="mt-0.5 truncate text-sm font-medium">{displayTitle(loop.issue.title, loop.titlePrefix)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {loopActivity(loop)} · {timeAgo(loop.updatedAt)}
          </p>
          {rounds && rounds.length > 1 && (
            <div className="mt-1.5">
              <RoundChain rounds={rounds} currentId={loop.id} onOpen={onOpen} />
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-muted-foreground transition-transform duration-300 ease-out group-hover:-translate-x-[5px] motion-reduce:transition-none motion-reduce:group-hover:translate-x-0">
          {loop.pr?.url && (
            <a
              href={loop.pr.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className={cn("hover:text-foreground", prStatus && PR_STATE_META[prStatus.state].tint)}
              title={prStatus ? prStatusTitle(prStatus, loop.pr.number) : `PR #${loop.pr.number}`}
            >
              <PrIcon className="size-4" />
            </a>
          )}
          {loop.devBuildUrl && (
            <a
              href={loop.devBuildUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="hover:text-foreground"
              title="Open dev build"
            >
              <Globe className="size-4" />
            </a>
          )}
          {loop.threads.implementation && (
            <a
              href={loop.threads.implementation.openUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="hover:text-foreground"
              title="Open in T3 Code"
            >
              <Terminal className="size-4" />
            </a>
          )}
          <a
            href={loop.issue.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="hover:text-foreground"
            title="Open in Linear"
          >
            <ExternalLink className="size-4" />
          </a>
        </div>
      </div>
    </ProjectCard>
  );
});
