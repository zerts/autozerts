import type { CSSProperties, ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { ProjectIcon } from "./ProjectIcon";
import { useProjectColor } from "@/lib/project-color";
import { cn } from "@/lib/utils";

/**
 * The shared card shell for loop/task rows. The project icon lives in a recessed
 * "tray" on the left — a surface very subtly tinted with the project's accent
 * (config override, else sampled from the icon). The content sits on an elevated
 * card surface over the tray and, on hover, slides a little to the right to
 * reveal more of the backdrop. There is intentionally no background color change
 * on hover — the only motion is that reveal.
 */
export function ProjectCard({
  repo,
  iconUrl,
  accent,
  onClick,
  className,
  children,
}: {
  repo?: string;
  iconUrl: string | null;
  /** Config accent override (CSS color); null/empty → derive from the icon. */
  accent?: string | null;
  onClick?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const derived = useProjectColor(repo ?? iconUrl ?? "project", iconUrl, accent);
  // Tasks with no project would otherwise get a random hashed hue. Tint them with a
  // theme neutral instead — `--muted-foreground` mixed at the same 14% reads at the
  // same intensity as the vivid project tints, just without the hue. The "has a
  // project" signal is the icon/accent, NOT `repo`: the server always fills `repo`
  // with a fallback default, so it's set even for unmatched tasks.
  const hasProject = Boolean(iconUrl || accent?.trim());
  const color = hasProject ? derived : "var(--muted-foreground)";
  return (
    <Card
      onClick={onClick}
      style={{ "--tint": color } as CSSProperties}
      className={cn("group relative isolate cursor-pointer gap-0 overflow-hidden p-0", className)}
    >
      {/* Recessed tray, tinted with the project accent. Wider than the visible
          strip so the hover reveal stays tinted; the rest hides under content.
          `--tint` is deliberately NOT named `--accent` so it doesn't clobber the
          theme's accent token (used by hover:bg-accent etc. inside the card). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-24"
        style={{ background: "color-mix(in oklab, var(--tint) 14%, var(--secondary))" }}
      />
      {/* Project icon — shifts half the content's hover slide so it stays centered
          in the widening visible tray. */}
      <div className="pointer-events-none absolute inset-y-0 left-0 z-0 flex w-14 items-center justify-center transition-transform duration-300 ease-out group-hover:translate-x-[2.5px] motion-reduce:transition-none motion-reduce:group-hover:translate-x-0">
        <ProjectIcon src={iconUrl} repo={repo} />
      </div>
      {/* Elevated content surface — a rounded panel that slides slightly right on
          hover to widen the tray. Right-edge action buttons counter-translate (see
          their callers) so they stay visually pinned while the panel shifts. */}
      <div
        className="relative z-10 ml-14 rounded-l-xl bg-card transition-transform duration-300 ease-out group-hover:translate-x-[5px] motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
        style={{ boxShadow: "-8px 0 18px -6px var(--shadow-color), -2px 0 6px -3px var(--shadow-color)" }}
      >
        {children}
      </div>
    </Card>
  );
}
