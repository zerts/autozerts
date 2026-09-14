import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { cn } from "@/lib/utils";

/**
 * Markdown renderer shared by the review report and the human PR comments.
 *
 * The project has no @tailwindcss/typography plugin, so `prose` classes are
 * no-ops — instead every element is styled explicitly here. Sizes use `em`
 * units so the whole block scales with the wrapper's font-size: the same
 * renderers serve the tiny preview card and the full-size dialog, the caller
 * just sets the base `text-…` class.
 *
 * `### [major/visual] Title` finding headings (the loop-review doc format) are
 * detected and rendered with a severity badge so a report can be scanned fast.
 */

const SEVERITY: Record<string, string> = {
  blocker: "bg-danger-soft text-danger",
  major: "bg-warning-soft text-warning",
  minor: "bg-muted text-muted-foreground",
};

function toText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(toText).join("");
  if (typeof node === "object" && "props" in node) {
    return toText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mt-[1em] mb-[0.5em] text-[1.4em] font-semibold tracking-tight first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-[1.2em] mb-[0.4em] border-b border-border pb-[0.25em] text-[1.18em] font-semibold tracking-tight first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => {
    const m = toText(children).match(/^\[(\w+)\/([\w-]+)\]\s*([\s\S]*)$/);
    if (m) {
      const [, severity, area, title] = m;
      return (
        <h3 className="mt-[1.1em] mb-[0.3em] flex flex-wrap items-center gap-[0.5em] text-[1.02em] font-semibold first:mt-0">
          <span
            className={cn(
              "rounded-sm px-[0.5em] py-[0.15em] text-[0.72em] font-semibold uppercase tracking-wide",
              SEVERITY[severity] ?? SEVERITY.minor,
            )}
          >
            {severity}
          </span>
          <span className="text-[0.78em] font-normal text-muted-foreground">{area}</span>
          <span>{title}</span>
        </h3>
      );
    }
    return <h3 className="mt-[1.1em] mb-[0.3em] text-[1.02em] font-semibold first:mt-0">{children}</h3>;
  },
  h4: ({ children }) => <h4 className="mt-[1em] mb-[0.3em] text-[1em] font-semibold first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="my-[0.6em] leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-[0.6em] list-disc space-y-[0.25em] pl-[1.4em] marker:text-muted-foreground">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-[0.6em] list-decimal space-y-[0.25em] pl-[1.4em] marker:text-muted-foreground">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-info underline underline-offset-2 hover:text-info/80"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="my-[0.6em] border-l-2 border-border pl-[1em] text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-[1em] border-border" />,
  code: ({ children }) => (
    <code className="rounded-sm bg-muted px-[0.4em] py-[0.1em] font-mono text-[0.88em]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-[0.6em] overflow-x-auto rounded-md bg-muted p-[0.9em] text-[0.82em] leading-relaxed text-foreground [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit">
      {children}
    </pre>
  ),
};

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("text-sm text-foreground [overflow-wrap:anywhere]", className)}>
      <ReactMarkdown components={components}>{children}</ReactMarkdown>
    </div>
  );
}
