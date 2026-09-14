import { cn } from "@/lib/utils";

/**
 * The project's dev-build icon (green = web app, orange = extension,
 * pink/purple = dashboard), served by the runner from each repo's config.
 * The repo is resolved from the issue's title prefix or its Linear label.
 * Renders nothing when no project matches.
 */
export function ProjectIcon({
  src,
  repo,
  className,
}: {
  src: string | null | undefined;
  repo?: string;
  className?: string;
}) {
  if (!src) return null;
  return (
    <img
      src={src}
      alt={repo ? `${repo} icon` : "project icon"}
      title={repo}
      className={cn("size-6 shrink-0 rounded-md object-contain", className)}
    />
  );
}
