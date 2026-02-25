/**
 * Generate a branch name from an issue summary and identifier.
 * Format: <summary-kebab-max-40>-<TEAM>-<id>
 * Example: fix-login-timeout-on-slow-conn-ENG-123
 */
export function generateBranchName(summary: string, issueKey: string): string {
  const kebab = summary
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

  const truncated =
    kebab.length > 40 ? kebab.slice(0, 40).replace(/-$/, "") : kebab;

  return `${truncated}-${issueKey}`;
}
