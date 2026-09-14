import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  CornerDownLeft,
  ExternalLink,
  GitPullRequest,
  Globe,
  LayoutDashboard,
  ListTodo,
  type LucideIcon,
  MessageSquare,
  Repeat2,
  Search,
  Terminal,
} from "lucide-react";
import { api, type ApiIssue, type ApiLoop } from "@/lib/api";
import { displayTitle, hostOf, loopActivity } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Self-contained command palette. It owns its own open state (⌘K / Ctrl+K),
 * dialog, search, keyboard navigation, and the lazy issue fetch — the host page
 * only renders it once and feeds it data through these props. Keep it that way:
 * this module should never reach into view internals, so it stays safe to
 * rework in isolation.
 */
export interface CommandMenuProps {
  /** Every loop the dashboard knows about (newest first). */
  loops: ApiLoop[];
  /** The loop currently open in the detail view, or null on the list views. */
  currentLoopId?: string | null;
  /** Push a new in-app route (same contract as the host's navigate). */
  onNavigate: (path: string) => void;
}

interface Command {
  id: string;
  group: string;
  label: string;
  /** Secondary line shown muted next to the label. */
  hint?: string;
  /** Extra text folded into the fuzzy match but never displayed. */
  keywords?: string;
  icon: LucideIcon;
  /** Opens in a new tab — shows the external-link affordance. */
  external?: boolean;
  perform: () => void;
}

function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Links surfaced by a single loop — the detail view's attachment rail, flattened. */
function loopLinks(loop: ApiLoop): Command[] {
  const out: Command[] = [];
  out.push({
    id: `link-linear-${loop.id}`,
    group: "Links",
    label: "Linear task",
    hint: loop.issue.identifier,
    icon: ExternalLink,
    external: true,
    perform: () => openExternal(loop.issue.url),
  });
  if (loop.pr?.url) {
    out.push({
      id: `link-pr-${loop.id}`,
      group: "Links",
      label: "Pull request",
      hint: `${loop.repo} · #${loop.pr.number}`,
      icon: GitPullRequest,
      external: true,
      perform: () => openExternal(loop.pr!.url!),
    });
  }
  if (loop.devBuildUrl) {
    out.push({
      id: `link-dev-${loop.id}`,
      group: "Links",
      label: "Dev build",
      hint: hostOf(loop.devBuildUrl),
      icon: Globe,
      external: true,
      perform: () => openExternal(loop.devBuildUrl!),
    });
  }
  if (loop.threads.implementation) {
    out.push({
      id: `link-impl-${loop.id}`,
      group: "Links",
      label: "Implementation thread",
      hint: `T3 Code · ${loop.threads.implementation.t3ThreadId}`,
      icon: Terminal,
      external: true,
      perform: () => openExternal(loop.threads.implementation!.openUrl),
    });
  }
  if (loop.threads.review) {
    out.push({
      id: `link-review-${loop.id}`,
      group: "Links",
      label: "Review thread",
      hint: `T3 Code · ${loop.threads.review.t3ThreadId}`,
      icon: Terminal,
      external: true,
      perform: () => openExternal(loop.threads.review!.openUrl),
    });
  }
  return out;
}

function loopCommand(loop: ApiLoop, group: string, navigate: (path: string) => void): Command {
  return {
    id: `loop-${group}-${loop.id}`,
    group,
    label: displayTitle(loop.issue.title, loop.titlePrefix),
    hint: `${loop.issue.identifier} · ${loopActivity(loop)}`,
    keywords: `${loop.issue.identifier} ${loop.repo} ${loop.state}`,
    icon: Repeat2,
    perform: () => navigate(`/loops/${loop.id}`),
  };
}

function issueCommand(issue: ApiIssue, navigate: (path: string) => void): Command {
  return {
    id: `issue-${issue.id}`,
    group: "Tasks",
    label: displayTitle(issue.title, issue.titlePrefix),
    // A task with a running loop jumps to it; otherwise the palette opens Linear.
    hint: issue.loop ? `${issue.identifier} · ${issue.loop.state}` : issue.identifier,
    keywords: `${issue.identifier} ${issue.state.name} ${issue.labels.join(" ")}`,
    icon: ListTodo,
    external: !issue.loop,
    perform: () =>
      issue.loop ? navigate(`/loops/${issue.loop.id}`) : openExternal(issue.url),
  };
}

/**
 * Assemble the command list for the current context. Order matters: the most
 * relevant group for where the user is sits first, since that is what they see
 * before typing.
 */
function buildCommands(
  loops: ApiLoop[],
  issues: ApiIssue[],
  currentLoopId: string | null | undefined,
  navigate: (path: string) => void,
): Command[] {
  const current = currentLoopId ? loops.find((l) => l.id === currentLoopId) ?? null : null;
  const commands: Command[] = [];

  if (current) {
    // Loop screen: its links first, then sibling loops in the same repo.
    commands.push(...loopLinks(current));
    const siblings = loops.filter((l) => l.repo === current.repo && l.id !== current.id);
    commands.push(...siblings.map((l) => loopCommand(l, `Loops in ${current.repo}`, navigate)));
  }

  commands.push({
    id: "go-dashboard",
    group: "Go to",
    label: "My Work",
    icon: LayoutDashboard,
    perform: () => navigate("/"),
  });
  commands.push({
    id: "go-tasks",
    group: "Go to",
    label: "Tasks",
    icon: ListTodo,
    perform: () => navigate("/tasks"),
  });

  // The general loop list. On a loop screen the same-repo siblings already
  // appear above, so drop them here to avoid listing a loop twice.
  const listed = current ? loops.filter((l) => l.repo !== current.repo) : loops;
  commands.push(...listed.map((l) => loopCommand(l, current ? "Other loops" : "Loops", navigate)));

  commands.push(...issues.map((i) => issueCommand(i, navigate)));

  return commands;
}

function matches(command: Command, query: string): boolean {
  if (!query) return true;
  const haystack = `${command.label} ${command.hint ?? ""} ${command.keywords ?? ""}`.toLowerCase();
  return query.split(/\s+/).every((token) => haystack.includes(token));
}

export function CommandMenu({ loops, currentLoopId, onNavigate }: CommandMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  // ⌘K / Ctrl+K toggles from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Tasks aren't on the dashboard payload, so fetch them lazily the first time
  // the palette opens and refresh on each subsequent open.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    api.issues().then(setIssues).catch(() => {});
  }, [open]);

  const navigate = useCallback(
    (path: string) => {
      onNavigate(path);
      setOpen(false);
    },
    [onNavigate],
  );

  const commands = useMemo(
    () => buildCommands(loops, issues, currentLoopId, navigate),
    [loops, issues, currentLoopId, navigate],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return commands.filter((c) => matches(c, q));
  }, [commands, query]);

  // Keep the active index in range as the filtered list shrinks/grows.
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Scroll the highlighted row into view as the selection moves.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function run(command: Command) {
    command.perform();
    if (!command.external) return; // external opens keep the palette where it was; nav already closed it
    setOpen(false);
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (filtered.length ? (i + 1) % filtered.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const command = filtered[active];
      if (command) run(command);
    }
  }

  // Render the grouped list, flattening to a single running index so keyboard
  // selection and the group headers stay in sync.
  let renderIndex = -1;
  let lastGroup = "";

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-xl bg-background px-2.5 py-1.5 text-xs text-muted-foreground shadow-[var(--elevation)] transition-colors hover:text-foreground"
        title="Command menu"
      >
        <Search className="size-3.5" />
        <span className="hidden sm:inline">Search</span>
        <kbd className="hidden rounded-sm bg-muted px-1 font-sans text-[10px] sm:inline">⌘K</kbd>
      </button>

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content
            className="fixed left-1/2 top-[12%] z-50 w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-xl bg-background shadow-2xl outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <DialogPrimitive.Title className="sr-only">Command menu</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Search loops, tasks, and links, or jump between screens.
            </DialogPrimitive.Description>

            <div className="flex items-center gap-2 border-b px-3">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKey}
                placeholder="Search loops, tasks, links…"
                className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>

            <div ref={listRef} className="max-h-[60vh] overflow-y-auto p-1.5">
              {filtered.length === 0 && (
                <p className="py-8 text-center text-sm text-muted-foreground">No matches.</p>
              )}
              {filtered.map((command) => {
                renderIndex += 1;
                const index = renderIndex;
                const isActive = index === active;
                const header = command.group !== lastGroup ? command.group : null;
                lastGroup = command.group;
                const Icon = command.icon;
                return (
                  <div key={command.id}>
                    {header && (
                      <p className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:pt-1">
                        {header}
                      </p>
                    )}
                    <button
                      data-active={isActive}
                      onMouseMove={() => setActive(index)}
                      onClick={() => run(command)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm",
                        isActive ? "bg-primary/10 text-foreground" : "text-foreground",
                      )}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{command.label}</span>
                      {command.hint && (
                        <span className="shrink-0 truncate text-xs text-muted-foreground">{command.hint}</span>
                      )}
                      {command.external ? (
                        <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        isActive && <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
