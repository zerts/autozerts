import { useEffect, useRef } from "react";
import { ProjectIcon } from "@/components/ProjectIcon";
import { ShortcutBadge } from "@/components/ShortcutBadge";
import { indexForLetterCode, isTypingTarget, letterForIndex } from "@/lib/shortcuts";
import type { Health } from "@/lib/api";

/**
 * Quick links to each configured repo's GitHub pull requests page, shown in the
 * dashboard's right rail. Rendered in the loop page's attachment-row style — a
 * "Pull requests" heading over a stack of separate mini-cards, each with the
 * project icon, repo name, and a Shift+letter jump badge (Shift+Q, W, E, …; the
 * loop list owns the Shift+number row). The repo list and icons come from the
 * runner config (`/api/health` → repoLinks); a repo with no resolvable GitHub
 * remote is skipped.
 */
export function RepoLinks({ repos }: { repos: Health["repoLinks"] }) {
  const links = repos.filter((r) => r.prsUrl);
  // The keyboard handler reads the current links off a ref so it can register once.
  const linksRef = useRef(links);
  linksRef.current = links;

  // Press a repo's Shift+letter (Shift+Q, W, E, …) to open its PRs in a new tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const index = indexForLetterCode(e.code);
      const link = index >= 0 ? linksRef.current[index] : undefined;
      if (link?.prsUrl) {
        e.preventDefault();
        window.open(link.prsUrl, "_blank", "noopener,noreferrer");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (links.length === 0) return null;
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground">Pull requests</h2>
      <div className="space-y-2">
        {links.map((repo, i) => {
          const shortcut = letterForIndex(i);
          return (
            <a
              key={repo.name}
              href={repo.prsUrl!}
              target="_blank"
              rel="noreferrer"
              className="group relative flex items-center gap-3 rounded-xl bg-card px-3 py-2.5 shadow-[var(--elevation)] transition-colors hover:bg-accent/30"
            >
              <ProjectIcon src={repo.iconUrl} repo={repo.name} className="size-7 rounded-lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{repo.name}</p>
                {repo.labels.length > 0 && (
                  <p className="truncate text-xs text-muted-foreground">{repo.labels.join(", ")}</p>
                )}
              </div>
              {shortcut && <ShortcutBadge shortcut={shortcut} compact className="absolute right-2 top-2" />}
            </a>
          );
        })}
      </div>
    </div>
  );
}
