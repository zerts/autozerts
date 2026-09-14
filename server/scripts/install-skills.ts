/**
 * Link every skill under <repo>/skills/ into ~/.claude/skills so Claude Code
 * (and T3 Code) can invoke them as /<name>. The runner dispatches these skills
 * by name, so they must be installed on any machine that runs it.
 * Usage: bun run install-skills [--uninstall]
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const REPO_SKILLS = path.resolve(import.meta.dir, "../../skills");
const TARGET = path.join(os.homedir(), ".claude", "skills");
const uninstall = process.argv.includes("--uninstall");

fs.mkdirSync(TARGET, { recursive: true });
for (const name of fs.readdirSync(REPO_SKILLS)) {
  const src = path.join(REPO_SKILLS, name);
  if (!fs.statSync(src).isDirectory()) continue;
  const dst = path.join(TARGET, name);
  const existing = fs.lstatSync(dst, { throwIfNoEntry: false });
  if (uninstall) {
    if (existing?.isSymbolicLink() && fs.readlinkSync(dst) === src) {
      fs.unlinkSync(dst);
      console.log(`unlinked ${dst}`);
    }
    continue;
  }
  if (existing) {
    if (existing.isSymbolicLink() && fs.readlinkSync(dst) === src) {
      console.log(`ok       ${name}`);
      continue;
    }
    console.error(`skip     ${name}: ${dst} already exists and is not a link to this repo — remove it first`);
    process.exitCode = 1;
    continue;
  }
  fs.symlinkSync(src, dst);
  console.log(`linked   ${name} -> ${dst}`);
}
