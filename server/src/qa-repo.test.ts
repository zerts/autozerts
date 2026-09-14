import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { qaRepoCheckout, qaRepoStatus } from "./qa-repo";

// Real git fixtures: an "origin" repo plus a "companion" clone, so the tests
// exercise the actual fetch / rev-list / checkout / pull behavior the control
// relies on — not a mock of it.

let root: string;
let origin: string;
let companion: string;

/** Run git in `cwd`, throwing on failure (with a fixed identity so commits work). */
function git(cwd: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", "-c", "user.email=t@t.io", "-c", "user.name=t", ...args], { cwd });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
  return res.stdout.toString().trim();
}

function commit(cwd: string, file: string, body: string) {
  fs.writeFileSync(path.join(cwd, file), body);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", `add ${file}`);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "qa-repo-test-"));
  origin = path.join(root, "origin");
  companion = path.join(root, "companion");

  fs.mkdirSync(origin);
  git(origin, "-c", "init.defaultBranch=main", "init");
  commit(origin, "README.md", "hello");
  git(origin, "branch", "-M", "main");
  // A feature branch with one extra commit, then back to main.
  git(origin, "checkout", "-b", "feature/wlt-1");
  commit(origin, "a.txt", "one");
  git(origin, "checkout", "main");

  git(root, "clone", origin, companion);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("qaRepoStatus", () => {
  test("on another branch, never-checked-out branch reports 0 unpulled", async () => {
    const s = await qaRepoStatus(companion, "feature/wlt-1");
    expect(s.currentBranch).toBe("main");
    expect(s.onBranch).toBe(false);
    expect(s.unpulled).toBe(0);
    expect(s.error).toBeUndefined();
  });

  test("a bad path surfaces an error instead of throwing", async () => {
    const s = await qaRepoStatus(path.join(root, "does-not-exist"), "feature/wlt-1");
    expect(s.error).toBeTruthy();
  });
});

describe("qaRepoCheckout", () => {
  test("checks out the task branch, then reports up-to-date", async () => {
    const s = await qaRepoCheckout(companion, "feature/wlt-1");
    expect(s.currentBranch).toBe("feature/wlt-1");
    expect(s.onBranch).toBe(true);
    expect(s.unpulled).toBe(0);
    expect(git(companion, "branch", "--show-current")).toBe("feature/wlt-1");
  });

  test("new origin commits show as unpulled, then a pull clears them", async () => {
    git(origin, "checkout", "feature/wlt-1");
    commit(origin, "b.txt", "two");
    git(origin, "checkout", "main");

    const behind = await qaRepoStatus(companion, "feature/wlt-1");
    expect(behind.onBranch).toBe(true);
    expect(behind.unpulled).toBe(1);

    const pulled = await qaRepoCheckout(companion, "feature/wlt-1");
    expect(pulled.unpulled).toBe(0);
    expect(fs.existsSync(path.join(companion, "b.txt"))).toBe(true);
  });
});
