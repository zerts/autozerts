/**
 * Review Doc courier (ADR-0001): reads LOOP-REVIEW.md from the Review
 * Thread's worktree, archives it per iteration in the data dir, parses the
 * Verdict header, and posts it as a PR comment. Never touches git.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ARCHIVED_QA_DOC,
  ARCHIVED_REVIEW_DOC,
  ARCHIVED_SCREENSHOTS_DIR,
  iterationDir,
  toStoredPath,
} from "../data-paths";

export const REVIEW_DOC_FILENAME = "LOOP-REVIEW.md";

export interface ParsedReviewDoc {
  verdict: "approved" | "needs-changes";
  findings: Array<{ severity: string; area: string; title: string; file?: string }>;
  body: string;
}

export function readReviewDoc(worktreePath: string): string | null {
  const docPath = path.join(worktreePath, REVIEW_DOC_FILENAME);
  try {
    return fs.readFileSync(docPath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Remove the worktree copy of LOOP-REVIEW.md. Called once a doc has been read
 * (consume-once) and before dispatching a review turn — so a doc found after
 * a turn settles was provably written by that turn, never a stale leftover
 * from an earlier iteration. The file is untracked, so this never touches git.
 */
export function clearReviewDoc(worktreePath: string): void {
  try {
    fs.unlinkSync(path.join(worktreePath, REVIEW_DOC_FILENAME));
  } catch {
    // already absent
  }
}

/**
 * Parse the YAML frontmatter contract. Deliberately forgiving: the verdict
 * line is the only hard requirement; findings are best-effort enrichment.
 */
export function parseReviewDoc(content: string): ParsedReviewDoc | null {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const header = fm[1];
  const verdictMatch = header.match(/^verdict:\s*(approved|needs-changes)\s*$/m);
  if (!verdictMatch) return null;

  const findings: ParsedReviewDoc["findings"] = [];
  // findings entries look like:
  //   - severity: major
  //     area: visual
  //     title: Button overlaps the footer
  //     file: src/App.tsx:42
  const entryRe = /-\s*severity:\s*(\S+)[\s\S]*?(?=\n\s*-\s*severity:|\n[a-zA-Z]|$)/g;
  for (const entry of header.matchAll(entryRe)) {
    const block = entry[0];
    const get = (key: string) => block.match(new RegExp(`${key}:\\s*(.+)`))?.[1]?.trim();
    findings.push({
      severity: get("severity") ?? "unknown",
      area: get("area") ?? "unknown",
      title: get("title") ?? "(untitled)",
      ...(get("file") ? { file: get("file") } : {}),
    });
  }

  return {
    verdict: verdictMatch[1] as ParsedReviewDoc["verdict"],
    findings,
    body: content.slice(fm[0].length).trim(),
  };
}

/**
 * Archive a review doc per (loop, iteration). Namespaced by loopId because
 * iteration numbers restart at 1 each round — without the loop segment, a
 * follow-up round's review docs would overwrite the prior round's, and the
 * loop feed shows every round's reviews side by side. Written to
 * `loops/<ISSUE>/<loopId>/<n>/review.md`; the returned path is relative to
 * the data dir, stored on the iteration row, and resolved by the API.
 */
export function archiveReviewDoc(issueIdentifier: string, loopId: string, iteration: number, content: string): string {
  const dir = iterationDir(issueIdentifier, loopId, iteration);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, ARCHIVED_REVIEW_DOC);
  fs.writeFileSync(filePath, content);
  return toStoredPath(filePath);
}

export function buildPrComment(iteration: number, maxIterations: number, parsed: ParsedReviewDoc): string {
  const emoji = parsed.verdict === "approved" ? "✅" : "🔄";
  const lines = [
    `## ${emoji} Loop review — iteration ${iteration}/${maxIterations}`,
    "",
    `**Verdict:** \`${parsed.verdict}\``,
    "",
  ];
  if (parsed.findings.length > 0) {
    lines.push("| Severity | Area | Finding |", "| --- | --- | --- |");
    for (const f of parsed.findings) {
      lines.push(`| ${f.severity} | ${f.area} | ${f.title}${f.file ? ` (\`${f.file}\`)` : ""} |`);
    }
    lines.push("");
  }
  lines.push(parsed.body, "", "_Posted by [ai-runner](http://127.0.0.1:4777)._");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// QA smoke-gate doc (QA-RESULT.md) — produced by /loop-qa on the impl thread.
// Same courier pattern as the review doc: read from the worktree, archive +
// screenshots, parse the frontmatter, post a PR comment, consume-once.
// ---------------------------------------------------------------------------

export const QA_DOC_FILENAME = "QA-RESULT.md";
/** Screenshot dir the skill writes inside the worktree (untracked). */
export const QA_ARTIFACT_DIR = ".qa-artifacts";

export interface QaScreenshot {
  file: string;
  label?: string;
}

export interface ParsedQaDoc {
  qa: "pass" | "fail";
  boots: boolean | null;
  visualChange: boolean | null;
  screenshots: QaScreenshot[];
  findings: Array<{ severity: string; area: string; title: string; file?: string }>;
  body: string;
}

export function readQaDoc(worktreePath: string): string | null {
  try {
    return fs.readFileSync(path.join(worktreePath, QA_DOC_FILENAME), "utf8");
  } catch {
    return null;
  }
}

/** Remove the worktree's QA-RESULT.md and screenshot dir (consume-once, untracked). */
export function clearQaDoc(worktreePath: string): void {
  try {
    fs.unlinkSync(path.join(worktreePath, QA_DOC_FILENAME));
  } catch {
    // already absent
  }
  try {
    fs.rmSync(path.join(worktreePath, QA_ARTIFACT_DIR), { recursive: true, force: true });
  } catch {
    // already absent
  }
}

/** Lines under a top-level `key:` in the frontmatter, until the next top-level key. */
function frontmatterSection(header: string, key: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const line of header.split("\n")) {
    if (new RegExp(`^${key}:`).test(line)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (/^[A-Za-z_]/.test(line)) break; // next top-level key
      out.push(line);
    }
  }
  return out;
}

/**
 * Parse QA-RESULT.md frontmatter. Forgiving like {@link parseReviewDoc}: the
 * `qa:` line is the only hard requirement; everything else is best-effort.
 */
export function parseQaDoc(content: string): ParsedQaDoc | null {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const header = fm[1];
  const qaMatch = header.match(/^qa:\s*(pass|fail)\s*$/m);
  if (!qaMatch) return null;

  const boolOf = (key: string): boolean | null => {
    const m = header.match(new RegExp(`^${key}:\\s*(true|false)\\s*$`, "m"));
    return m ? m[1] === "true" : null;
  };

  const screenshots: QaScreenshot[] = [];
  let current: QaScreenshot | null = null;
  for (const line of frontmatterSection(header, "screenshots")) {
    const fileM = line.match(/^\s*-\s*file:\s*(.+\S)\s*$/);
    if (fileM) {
      if (current) screenshots.push(current);
      current = { file: fileM[1].trim() };
      continue;
    }
    const labelM = line.match(/^\s*label:\s*(.+\S)\s*$/);
    if (labelM && current) current.label = labelM[1].trim();
  }
  if (current) screenshots.push(current);

  const findings: ParsedQaDoc["findings"] = [];
  const entryRe = /-\s*severity:\s*(\S+)[\s\S]*?(?=\n\s*-\s*severity:|\n[a-zA-Z]|$)/g;
  for (const entry of frontmatterSection(header, "findings").join("\n").matchAll(entryRe)) {
    const block = entry[0];
    const get = (key: string) => block.match(new RegExp(`${key}:\\s*(.+)`))?.[1]?.trim();
    findings.push({
      severity: get("severity") ?? "unknown",
      area: get("area") ?? "unknown",
      title: get("title") ?? "(untitled)",
      ...(get("file") ? { file: get("file") } : {}),
    });
  }

  return {
    qa: qaMatch[1] as ParsedQaDoc["qa"],
    boots: boolOf("boots"),
    visualChange: boolOf("visual_change"),
    screenshots,
    findings,
    body: content.slice(fm[0].length).trim(),
  };
}

export interface ArchivedQa {
  /** Archived qa.md, relative to the data dir. */
  docPath: string;
  /** Archived screenshots (copied out of the worktree), paths relative to the data dir. */
  images: Array<{ path: string; label?: string }>;
}

/**
 * Archive QA-RESULT.md (as `qa.md`) and its screenshots into the iteration
 * dir `loops/<ISSUE>/<loopId>/<n>/` — the same dir the review doc lands in —
 * copying the PNGs out of the worktree before it's cleared. Missing
 * screenshots are skipped.
 */
export function archiveQaArtifacts(
  issueIdentifier: string,
  loopId: string,
  iteration: number,
  worktreePath: string,
  docContent: string,
  screenshots: QaScreenshot[],
): ArchivedQa {
  const dir = iterationDir(issueIdentifier, loopId, iteration);
  const shotsDir = path.join(dir, ARCHIVED_SCREENSHOTS_DIR);
  fs.mkdirSync(shotsDir, { recursive: true });
  const docPath = path.join(dir, ARCHIVED_QA_DOC);
  fs.writeFileSync(docPath, docContent);

  const images: ArchivedQa["images"] = [];
  for (const ss of screenshots) {
    const src = path.join(worktreePath, ss.file);
    const dest = path.join(shotsDir, path.basename(ss.file));
    try {
      fs.copyFileSync(src, dest);
      images.push({ path: toStoredPath(dest), ...(ss.label ? { label: ss.label } : {}) });
    } catch {
      // screenshot referenced but not on disk — skip, the comment notes it
    }
  }
  return { docPath: toStoredPath(docPath), images };
}

/** A screenshot ready to embed in the PR comment — `url` set when hosting succeeded. */
export interface QaImageRef {
  name: string;
  label?: string;
  url?: string;
}

export function buildQaPrComment(
  iteration: number,
  maxIterations: number,
  parsed: ParsedQaDoc,
  imageRefs: QaImageRef[],
): string {
  const emoji = parsed.qa === "pass" ? "✅" : "🔴";
  const lines = [
    `## ${emoji} QA smoke gate — iteration ${iteration}/${maxIterations}`,
    "",
    `**Result:** \`${parsed.qa}\`${parsed.boots === false ? " — app did not boot" : ""}`,
    "",
  ];
  if (parsed.findings.length > 0) {
    lines.push("| Severity | Area | Finding |", "| --- | --- | --- |");
    for (const f of parsed.findings) {
      lines.push(`| ${f.severity} | ${f.area} | ${f.title}${f.file ? ` (\`${f.file}\`)` : ""} |`);
    }
    lines.push("");
  }
  if (imageRefs.length > 0) {
    lines.push("### Screenshots", "");
    for (const r of imageRefs) {
      const caption = r.label ?? r.name;
      lines.push(r.url ? `**${caption}**\n\n![${caption}](${r.url})` : `- ${caption} _(archived locally; not hosted)_`);
      lines.push("");
    }
  }
  lines.push(parsed.body, "", "_Posted by [ai-runner](http://127.0.0.1:4777)._");
  return lines.join("\n");
}
