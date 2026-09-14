import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ShortcutBadge } from "./ShortcutBadge";

/**
 * A Linear-style attachment row: a full-width clickable mini-card with a leading
 * icon, a title + optional subtitle, and an optional right-side badge. Rendered
 * as a stack right after the main Loop card on the detail page.
 *
 * The `badge` slot is intentionally left ready for live statuses (PR open/merged,
 * Linear workflow state) that aren't wired up yet.
 */
export function AttachmentRow({
  icon: Icon,
  title,
  titleAdornment,
  subtitle,
  href,
  badge,
  shortcut,
  unstable,
}: {
  icon: LucideIcon;
  title: string;
  /** Inline element shown right after the title on its first line (e.g. a PR status icon). */
  titleAdornment?: ReactNode;
  subtitle?: string | null;
  href: string;
  badge?: ReactNode;
  /** Single-key shortcut (1–9, 0) that opens this link from the loop page. */
  shortcut?: string;
  /**
   * Render the row in a dimmer, dashed-border "not a stable link" style — for
   * shared environments (e.g. a staging URL) that other branches can overwrite.
   */
  unstable?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={
        unstable
          ? "group relative flex items-center gap-3 rounded-xl border border-dashed bg-card/40 px-3 py-2.5 text-muted-foreground transition-colors hover:bg-[#f6f6f6]"
          : "group relative flex items-center gap-3 rounded-xl bg-card px-3 py-2.5 shadow-[var(--elevation)] transition-colors hover:bg-[#f6f6f6]"
      }
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-medium">{title}</p>
          {titleAdornment}
        </div>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {badge}
      {/* The shortcut badge stands in for the usual external-link affordance:
          tucked in the corner, it hints the Shift+number jump for this link. */}
      {shortcut && <ShortcutBadge shortcut={shortcut} compact className="absolute right-2 top-2" />}
    </a>
  );
}
