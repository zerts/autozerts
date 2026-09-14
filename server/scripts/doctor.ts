/**
 * Environment doctor: checks everything the Runner and its skills need on this
 * machine and reports what is missing. Read-only — it never writes or installs.
 *
 * Usage:
 *   bun run doctor            human-readable checklist (exit 1 if anything failed)
 *   bun run doctor --json     machine-readable, for the /runner-setup skill
 *   bun run doctor --offline  skip network checks (Linear API, gh auth)
 *
 * Kept deliberately dependency-free beyond `config` and the T3 state reader so
 * it works on a fresh clone with no .env: every missing piece is a finding, not
 * a crash.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, CONFIG_JSON_PATH } from "../src/config";
import { T3_USER_DATA, SERVER_RUNTIME_PATH, readActiveSession, findProjectByWorkspaceRoot } from "../src/t3/state";

type Status = "ok" | "warn" | "fail" | "skip";

interface Check {
  /** Stable id the setup skill keys off. */
  id: string;
  /** Phase the setup skill groups it under. */
  phase: "prereqs" | "t3" | "claude" | "env" | "repos" | "private" | "data" | "service";
  status: Status;
  title: string;
  detail?: string;
  /** What to do about it. Omitted when ok. */
  fix?: string;
}

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SKILLS_DIR = path.join(REPO_ROOT, "skills");
const PRIVATE_DIR = path.resolve(REPO_ROOT, "..", "autozerts-private");
const CLAUDE_SKILLS = path.join(os.homedir(), ".claude", "skills");
const LAUNCHD_LABEL = "com.autozerts.ai-runner";
const PLIST_PATH = path.join(os.homedir(), "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`);

const json = process.argv.includes("--json");
const offline = process.argv.includes("--offline");

const checks: Check[] = [];
const add = (c: Check) => checks.push(c);

function exists(p: string): boolean {
  return fs.existsSync(p);
}

function run(cmd: string[], cwd?: string): { code: number; out: string } {
  try {
    const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    const out = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
    return { code: proc.exitCode ?? 1, out };
  } catch {
    return { code: 127, out: "" };
  }
}

function which(bin: string): string | null {
  const r = run(["which", bin]);
  return r.code === 0 && r.out ? r.out.split("\n")[0] : null;
}

// ---------------------------------------------------------------------------
// prereqs
// ---------------------------------------------------------------------------

add({ id: "bun", phase: "prereqs", status: "ok", title: `Bun ${Bun.version}` });

if (process.platform !== "darwin") {
  add({
    id: "platform",
    phase: "prereqs",
    status: "warn",
    title: `Platform is ${process.platform}`,
    detail: "The background service uses macOS launchd; run `bun run start` manually elsewhere.",
  });
}

{
  const gh = which("gh");
  if (!gh) {
    add({ id: "gh", phase: "prereqs", status: "fail", title: "GitHub CLI (gh) not found", fix: "brew install gh && gh auth login" });
  } else if (offline) {
    add({ id: "gh", phase: "prereqs", status: "skip", title: "gh auth (offline)" });
  } else {
    const r = run(["gh", "auth", "status"]);
    add(
      r.code === 0
        ? { id: "gh", phase: "prereqs", status: "ok", title: "gh authenticated" }
        : { id: "gh", phase: "prereqs", status: "fail", title: "gh not authenticated", detail: r.out.split("\n")[0], fix: "gh auth login" },
    );
  }
}

{
  const pw = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  const has = exists(pw) && fs.readdirSync(pw).some((d) => d.startsWith("chromium"));
  add(
    has
      ? { id: "playwright", phase: "prereqs", status: "ok", title: "Playwright Chromium cached" }
      : {
          id: "playwright",
          phase: "prereqs",
          status: "warn",
          title: "Playwright Chromium not cached yet",
          detail: "Skills install it on first use; pre-installing avoids a slow first QA run.",
          fix: "npx playwright install chromium",
        },
  );
}

// ---------------------------------------------------------------------------
// t3
// ---------------------------------------------------------------------------

if (!exists(T3_USER_DATA)) {
  add({ id: "t3.userdata", phase: "t3", status: "fail", title: "T3 Code has never run on this machine", detail: T3_USER_DATA, fix: "Install T3 Code, open it, and sign in." });
} else {
  add({ id: "t3.userdata", phase: "t3", status: "ok", title: "T3 Code user data present" });
  const key = path.join(T3_USER_DATA, "secrets", "server-signing-key.bin");
  add(
    exists(key)
      ? { id: "t3.signing-key", phase: "t3", status: "ok", title: "T3 signing key present" }
      : { id: "t3.signing-key", phase: "t3", status: "fail", title: "T3 signing key missing", detail: key, fix: "Sign in to T3 Code once; it creates the key." },
  );
  try {
    const s = readActiveSession();
    const hours = Math.round((s.expiresAtMs - Date.now()) / 36e5);
    add({ id: "t3.session", phase: "t3", status: "ok", title: `T3 session active (expires in ~${hours}h)` });
  } catch (e) {
    add({ id: "t3.session", phase: "t3", status: "fail", title: "No active T3 session", detail: (e as Error).message, fix: "Open T3 Code and sign in." });
  }
  add(
    exists(SERVER_RUNTIME_PATH)
      ? { id: "t3.runtime", phase: "t3", status: "ok", title: "T3 server runtime file present" }
      : { id: "t3.runtime", phase: "t3", status: "warn", title: "T3 server not running right now", detail: SERVER_RUNTIME_PATH, fix: "Launch T3 Code before starting loops." },
  );
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

{
  const skills = fs.existsSync(SKILLS_DIR) ? fs.readdirSync(SKILLS_DIR).filter((n) => fs.statSync(path.join(SKILLS_DIR, n)).isDirectory()) : [];
  const missing: string[] = [];
  const foreign: string[] = [];
  for (const name of skills) {
    const dst = path.join(CLAUDE_SKILLS, name);
    const st = fs.lstatSync(dst, { throwIfNoEntry: false });
    if (!st) missing.push(name);
    else if (!(st.isSymbolicLink() && fs.readlinkSync(dst) === path.join(SKILLS_DIR, name))) foreign.push(name);
  }
  if (!missing.length && !foreign.length) add({ id: "claude.skills", phase: "claude", status: "ok", title: `${skills.length} skills linked into ~/.claude/skills` });
  else
    add({
      id: "claude.skills",
      phase: "claude",
      status: "fail",
      title: "Skills not linked",
      detail: [missing.length && `missing: ${missing.join(", ")}`, foreign.length && `not ours: ${foreign.join(", ")}`].filter(Boolean).join("; "),
      fix: foreign.length ? `Remove ~/.claude/skills/{${foreign.join(",")}} then run: bun run install-skills` : "bun run install-skills",
    });
}

{
  // Best effort: the Linear MCP server can be configured in several places and
  // claude.ai connectors leave no local trace at all, so we only report what we can see.
  const candidates = [path.join(os.homedir(), ".claude.json"), path.join(os.homedir(), ".claude", "settings.json"), path.join(REPO_ROOT, ".mcp.json")];
  const seen = candidates.some((p) => exists(p) && /linear/i.test(fs.readFileSync(p, "utf8")));
  add(
    seen
      ? { id: "claude.linear-mcp", phase: "claude", status: "ok", title: "Linear MCP server referenced in Claude config" }
      : {
          id: "claude.linear-mcp",
          phase: "claude",
          status: "warn",
          title: "Linear MCP server not detected locally",
          detail: "Skills call mcp__claude_ai_Linear__* tools. If you use the claude.ai Linear connector this is expected; otherwise add one.",
          fix: "Connect Linear in claude.ai connectors, or `claude mcp add linear ...` (see Linear's MCP docs).",
        },
  );
}

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

{
  const envPath = path.join(REPO_ROOT, ".env");
  add(
    exists(envPath)
      ? { id: "env.file", phase: "env", status: "ok", title: ".env present" }
      : { id: "env.file", phase: "env", status: "warn", title: ".env missing", detail: "Runner boots with defaults but has no Linear key and no repos.", fix: "cp .env.example .env" },
  );
  const key = config.linearApiKey;
  if (!key || key === "lin_api_...") {
    add({ id: "env.linear-key", phase: "env", status: "fail", title: "LINEAR_API_KEY not set", fix: "Create a personal API key at linear.app → Settings → API, paste into .env (never into chat)." });
  } else if (offline) {
    add({ id: "env.linear-key", phase: "env", status: "skip", title: "LINEAR_API_KEY set (not verified, offline)" });
  } else {
    try {
      const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: key },
        body: JSON.stringify({ query: "{ viewer { name organization { name } } }" }),
        signal: AbortSignal.timeout(8000),
      });
      const body = (await res.json()) as { data?: { viewer: { name: string; organization: { name: string } } }; errors?: unknown };
      if (res.ok && body.data) add({ id: "env.linear-key", phase: "env", status: "ok", title: `Linear key valid (${body.data.viewer.name} @ ${body.data.viewer.organization.name})` });
      else add({ id: "env.linear-key", phase: "env", status: "fail", title: `Linear rejected the key (HTTP ${res.status})`, fix: "Regenerate the key in Linear and update .env." });
    } catch (e) {
      add({ id: "env.linear-key", phase: "env", status: "warn", title: "Could not reach Linear API", detail: (e as Error).message });
    }
  }
}

// ---------------------------------------------------------------------------
// repos
// ---------------------------------------------------------------------------

if (!config.repos.length) {
  add({
    id: "repos.any",
    phase: "repos",
    status: "fail",
    title: "No repos configured",
    detail: exists(CONFIG_JSON_PATH) ? `config.json has none: ${CONFIG_JSON_PATH}` : "Neither DATA_DIR/config.json nor env REPOS define any.",
    fix: "Set REPOS in .env (seed) or add repos on the dashboard Config page.",
  });
} else {
  add({ id: "repos.any", phase: "repos", status: "ok", title: `${config.repos.length} repo(s) configured`, detail: config.repos.map((r) => r.name).join(", ") });
  for (const r of config.repos) {
    const id = `repos.${r.name}`;
    if (!exists(r.localPath)) {
      add({ id, phase: "repos", status: "fail", title: `${r.name}: localPath missing`, detail: r.localPath, fix: "Clone it there or fix localPath." });
      continue;
    }
    const branch = run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${r.defaultBranch}`], r.localPath);
    if (branch.code !== 0) {
      add({ id, phase: "repos", status: "fail", title: `${r.name}: branch "${r.defaultBranch}" not found`, detail: r.localPath, fix: "Fix defaultBranch (main vs master) or fetch it." });
      continue;
    }
    let project = null;
    try {
      project = findProjectByWorkspaceRoot(r.localPath);
    } catch {
      /* T3 missing — already reported */
    }
    add(
      project
        ? { id, phase: "repos", status: "ok", title: `${r.name}: path, branch, T3 project ok` }
        : {
            id,
            phase: "repos",
            status: "warn",
            title: `${r.name}: not registered as a T3 Code project`,
            detail: "Dispatch needs a T3 project whose workspace root equals localPath.",
            fix: `In T3 Code, add the project at ${r.localPath}.`,
          },
    );
    if (r.qaGate) {
      const remote = run(["git", "remote", "get-url", "origin"], r.localPath).out;
      const profileName = remote ? path.basename(remote).replace(/\.git$/, "") : r.name;
      const profile = path.join(PRIVATE_DIR, "qa-profiles", `${profileName}.md`);
      add(
        exists(profile)
          ? { id: `${id}.qa-profile`, phase: "private", status: "ok", title: `${r.name}: QA profile present (${profileName}.md)` }
          : {
              id: `${id}.qa-profile`,
              phase: "private",
              status: "fail",
              title: `${r.name}: qaGate on but no QA profile`,
              detail: profile,
              fix: `Copy templates/private-repo/qa-profiles/_example.md to ${profile} and fill it in, or set qaGate: false.`,
            },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// private sibling
// ---------------------------------------------------------------------------

add(
  exists(PRIVATE_DIR)
    ? { id: "private.dir", phase: "private", status: "ok", title: "Private sibling repo present", detail: PRIVATE_DIR }
    : {
        id: "private.dir",
        phase: "private",
        status: "warn",
        title: "Private sibling repo missing",
        detail: `${PRIVATE_DIR} — required only for repos with qaGate.`,
        fix: "cp -R templates/private-repo ../autozerts-private && (cd ../autozerts-private && git init)",
      },
);

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------

{
  const d = config.dataDir;
  if (!exists(d)) add({ id: "data.dir", phase: "data", status: "warn", title: "Data dir does not exist yet", detail: `${d} — created on first boot.` });
  else {
    try {
      fs.accessSync(d, fs.constants.W_OK);
      add({ id: "data.dir", phase: "data", status: "ok", title: "Data dir writable", detail: d });
    } catch {
      add({ id: "data.dir", phase: "data", status: "fail", title: "Data dir not writable", detail: d, fix: `chmod u+w ${d}` });
    }
  }
  const secrets = path.join(d, "qa", "secrets");
  if (config.repos.some((r) => r.qaGate)) {
    add(
      exists(secrets)
        ? { id: "data.qa-secrets", phase: "data", status: "ok", title: "qa/secrets dir present" }
        : { id: "data.qa-secrets", phase: "data", status: "warn", title: "qa/secrets dir missing", detail: `${secrets} — QA profiles read test-account credentials from here.`, fix: `mkdir -p ${secrets}` },
    );
  }
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

add(
  exists(path.join(REPO_ROOT, "web", "dist", "index.html"))
    ? { id: "service.web-dist", phase: "service", status: "ok", title: "web/dist built" }
    : { id: "service.web-dist", phase: "service", status: "fail", title: "web/dist not built", detail: "The server serves the built UI; without it the dashboard 404s.", fix: "bun run build:web" },
);

if (process.platform === "darwin") {
  if (!exists(PLIST_PATH)) add({ id: "service.launchd", phase: "service", status: "warn", title: "launchd agent not installed", detail: "Optional; run `bun run start` by hand instead.", fix: "bun run install-agent" });
  else {
    const r = run(["launchctl", "print", `gui/${process.getuid!()}/${LAUNCHD_LABEL}`]);
    const running = r.code === 0 && /state = running/.test(r.out);
    add(
      running
        ? { id: "service.launchd", phase: "service", status: "ok", title: `launchd agent running (${LAUNCHD_LABEL})` }
        : { id: "service.launchd", phase: "service", status: "warn", title: "launchd agent installed but not running", fix: `launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}` },
    );
  }
}

if (!offline) {
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(2000) });
    const h = (await res.json()) as { t3: string; gh: string; repos: string[] };
    add({ id: "service.health", phase: "service", status: "ok", title: `Runner answering on :${config.port}`, detail: `t3=${h.t3} gh=${h.gh} repos=${h.repos.length}` });
  } catch {
    add({ id: "service.health", phase: "service", status: "warn", title: `Runner not listening on :${config.port}`, fix: "bun run start   (or bun run install-agent)" });
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const failed = checks.filter((c) => c.status === "fail").length;
const warned = checks.filter((c) => c.status === "warn").length;

if (json) {
  console.log(JSON.stringify({ ok: failed === 0, failed, warned, repoRoot: REPO_ROOT, privateDir: PRIVATE_DIR, dataDir: config.dataDir, checks }, null, 2));
} else {
  const icon: Record<Status, string> = { ok: "✔", warn: "!", fail: "✘", skip: "–" };
  const order: Check["phase"][] = ["prereqs", "t3", "claude", "env", "repos", "private", "data", "service"];
  const sorted = [...checks].sort((a, b) => order.indexOf(a.phase) - order.indexOf(b.phase));
  let phase = "";
  for (const c of sorted) {
    if (c.phase !== phase) {
      phase = c.phase;
      console.log(`\n${phase}`);
    }
    console.log(`  ${icon[c.status]} ${c.title}`);
    if (c.detail) console.log(`      ${c.detail}`);
    if (c.fix) console.log(`      → ${c.fix}`);
  }
  console.log(`\n${failed} failed, ${warned} warnings. ${failed ? "Fix the ✘ items, then re-run `bun run doctor`." : "Ready."}`);
}
process.exitCode = failed ? 1 : 0;
