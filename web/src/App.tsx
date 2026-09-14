import { useCallback, useEffect, useRef, useState } from "react";
import { Dashboard } from "@/views/Dashboard";
import { Tasks } from "@/views/Tasks";
import { LoopDetail } from "@/views/LoopDetail";
import { Config } from "@/views/Config";
import { api, subscribeEvents, type ApiLoop, type Health, type PrStatus } from "@/lib/api";
import { ThemeStudio } from "@/components/ThemeStudio";
import { UsageStudio } from "@/components/UsageStudio";
import { CommandMenu } from "@/components/CommandMenu";
import { cn } from "@/lib/utils";

type Route = { view: "dashboard" } | { view: "tasks" } | { view: "config" } | { view: "loop"; id: string };

/**
 * Keep the previous state when a freshly fetched payload is structurally
 * identical — fetch always produces new object identities, and without this
 * every poll/SSE tick re-rendered the whole tree (and invalidated every memo
 * keyed on these objects) even when nothing changed.
 */
function replaceIfChanged<T>(next: T): (prev: T | null) => T {
  const nextJson = JSON.stringify(next);
  return (prev) => (prev !== null && JSON.stringify(prev) === nextJson ? prev : next);
}

function parseRoute(): Route {
  const path = window.location.pathname;
  if (path === "/tasks") return { view: "tasks" };
  if (path === "/config") return { view: "config" };
  const loopMatch = path.match(/^\/loops\/([\w-]+)$/);
  if (loopMatch) return { view: "loop", id: loopMatch[1] };
  return { view: "dashboard" };
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseRoute);
  const [loops, setLoops] = useState<ApiLoop[]>([]);
  const [prStatuses, setPrStatuses] = useState<Record<string, PrStatus>>({});
  const [health, setHealth] = useState<Health | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const navigate = useCallback((path: string) => {
    window.history.pushState(null, "", path);
    setRoute(parseRoute());
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // The loop-detail view refetches on every refreshKey tick, but nothing else
  // consumes it — only bump it while a loop is actually open, so background
  // polls don't force an app-wide re-render on the other views.
  const routeRef = useRef(route);
  routeRef.current = route;

  const refresh = useCallback(() => {
    api.loops().then((next) => setLoops(replaceIfChanged(next))).catch(() => {});
    api.prStatuses().then((next) => setPrStatuses(replaceIfChanged(next))).catch(() => {});
    api.health().then((next) => setHealth(replaceIfChanged(next))).catch(() => setHealth(null));
    if (routeRef.current.view === "loop") setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    refresh();
    const unsubscribe = subscribeEvents(refresh);
    const interval = setInterval(refresh, 30_000);
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [refresh]);

  // Stable identity so memoized cards (LoopCard) don't re-render when App does.
  const openLoop = useCallback((id: string) => navigate(`/loops/${id}`), [navigate]);

  const t3Down = health !== null && health.t3 === "down";

  // Every view now runs the same two-column layout (content + sticky rail), so
  // they share one shell width — the columns line up as you navigate between them.
  const shellWidth = "max-w-6xl";

  return (
    <div className="app-shell min-h-screen">
      <header
        className="sticky top-0 z-10 bg-card"
        style={{ boxShadow: "0 8px 18px -6px var(--shadow-color), 0 2px 6px -3px var(--shadow-color)" }}
      >
        <div className="flex h-12 items-center px-4">
          <span className="flex flex-1 items-center gap-2 text-sm font-semibold tracking-tight">
            <img src="/favicon.png" alt="" className="h-5 w-5 rounded-sm" />
            <span className="hidden sm:inline">AutoZerts</span>
          </span>
          <nav className="flex gap-0.5 sm:gap-1">
            {(
              [
                ["My Work", "/", "dashboard"],
                ["Tasks", "/tasks", "tasks"],
                ["Config", "/config", "config"],
              ] as const
            ).map(([label, path, view]) => (
              <button
                key={path}
                onClick={() => navigate(path)}
                className={cn(
                  "rounded-xl px-2 py-1.5 text-sm transition-colors sm:px-3",
                  route.view === view
                    ? "bg-secondary font-medium"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="flex flex-1 items-center justify-end gap-2 text-xs text-muted-foreground sm:gap-4">
            <CommandMenu
              loops={loops}
              currentLoopId={route.view === "loop" ? route.id : null}
              onNavigate={navigate}
            />
            {health === null ? (
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-muted-foreground/40" />
                <span className="hidden sm:inline">runner offline</span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <span className={cn("size-2 rounded-full", t3Down ? "bg-danger" : "bg-success")} />
                <span className="hidden sm:inline">T3 Code {t3Down ? "down" : "up"}</span>
              </span>
            )}
          </div>
        </div>
      </header>

      {t3Down && (
        <div className="border-b border-danger/30 bg-danger-soft px-4 py-2 text-center text-sm text-danger">
          T3 Code is not running — loops are paused and will resume automatically.
        </div>
      )}

      <main className={cn("mx-auto px-4 py-6", shellWidth)}>
        {route.view === "dashboard" && (
          <Dashboard loops={loops} prStatuses={prStatuses} health={health} onOpen={openLoop} />
        )}
        {route.view === "tasks" && <Tasks health={health} onLoopOpened={openLoop} />}
        {route.view === "config" && <Config />}
        {route.view === "loop" && (
          <LoopDetail
            id={route.id}
            onBack={() => navigate("/")}
            onOpenLoop={(id) => navigate(`/loops/${id}`)}
            prStatuses={prStatuses}
            refreshKey={refreshKey}
          />
        )}
      </main>

      <div className="fixed bottom-2 right-2 z-50 flex items-center gap-2 print:hidden">
        <UsageStudio />
        <ThemeStudio />
      </div>
    </div>
  );
}
