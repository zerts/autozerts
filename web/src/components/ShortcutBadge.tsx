import { ArrowBigUp } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A Shift+number jump shortcut, shown as a keyboard key with a leading ⇧ glyph so
 * it reads as "press this", not just a position number. `compact` shrinks it for
 * tight corners (e.g. the loop page's quick links).
 */
export function ShortcutBadge({
  shortcut,
  className,
  compact,
}: {
  shortcut: string;
  className?: string;
  compact?: boolean;
}) {
  return (
    <kbd
      className={cn(
        "flex items-center rounded-sm bg-muted font-sans font-medium text-muted-foreground",
        compact ? "gap-0.5 px-1 py-0.5 text-[9px] leading-none" : "gap-1 px-1.5 py-0.5 text-[11px]",
        className,
      )}
    >
      <ArrowBigUp className={compact ? "size-2.5" : "size-3"} />
      {shortcut}
    </kbd>
  );
}
