/**
 * One-off backfill: for every loop that has a PR but no captured dev-build
 * link, fetch the CI "deployed to domain" comment and attach the link to both
 * the loop state and the Linear card.
 *
 * Safe to re-run — loops that already have a link, or whose PR hasn't been
 * deployed yet, are skipped. Runs fine while the daemon is up (WAL + busy
 * timeout); the engine's own capture skips any loop this has already filled.
 *
 *   bun run server/scripts/backfill-dev-build-links.ts
 */
import { db, loopsRepo } from "../src/db";
import { findRepo } from "../src/config";
import { fetchDevBuildUrl } from "../src/github";
import { createAttachment } from "../src/linear";

db.exec("PRAGMA busy_timeout = 5000");

const loops = loopsRepo.all().filter((l) => l.pr_number && !l.dev_build_url);
console.log(`Checking ${loops.length} loop(s) with a PR and no dev-build link…`);

let attached = 0;
for (const loop of loops) {
  const tag = `${loop.issue_identifier} (PR #${loop.pr_number})`;
  const repo = findRepo(loop.repo_name);
  if (!repo) {
    console.warn(`  ${tag}: unknown repo ${loop.repo_name} — skipped`);
    continue;
  }

  let url: string | null = null;
  try {
    url = await fetchDevBuildUrl(repo.localPath, loop.pr_number!);
  } catch (error) {
    console.warn(`  ${tag}: lookup failed — ${String(error)}`);
    continue;
  }
  if (!url) {
    console.log(`  ${tag}: no dev-build comment yet`);
    continue;
  }

  loopsRepo.update(loop.id, { dev_build_url: url });
  try {
    await createAttachment({ issueId: loop.issue_id, url, title: "Dev build", subtitle: `PR #${loop.pr_number}` });
  } catch (error) {
    console.warn(`  ${tag}: stored link but Linear attachment failed — ${String(error)}`);
  }
  attached++;
  console.log(`  ${tag}: ${url}`);
}

console.log(`Done — attached ${attached} dev-build link(s) across ${loops.length} candidate loop(s).`);
process.exit(0);
