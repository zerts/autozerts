/**
 * Generate a branch name from a JIRA issue summary and key.
 * Format: <summary-kebab-max-40>-<PROJECT>-<id>
 * Example: fix-login-timeout-on-slow-conn-WLT-123
 */
export function generateBranchName(summary: string, jiraKey: string): string {
  const kebab = summary
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

  const truncated =
    kebab.length > 40 ? kebab.slice(0, 40).replace(/-$/, "") : kebab;

  return `${truncated}-${jiraKey}`;
}
