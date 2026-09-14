/** Branch naming rules shared by the engine and API. */

/** Linear's branchName, truncated to 64 chars at the last `-` boundary (same rule as linear-implement). */
export function taskBranchFromIssue(branchName: string): string {
  if (branchName.length <= 64) return branchName;
  const cut = branchName.slice(0, 64);
  const lastDash = cut.lastIndexOf("-");
  return lastDash > 0 ? cut.slice(0, lastDash) : cut;
}

/** Review Branch convention, identical to the Raycast extension's generateQaBranchName. */
export function generateQaBranchName(headRef: string): string {
  return `qa/${headRef}-${Date.now().toString(36)}`;
}
