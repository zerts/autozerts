import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RepoConfig {
  name: string;
  localPath: string;
  defaultBranch: string;
  issuePrefixes?: string[];
  /**
   * Linear label names (case-insensitive) that map an issue to this repo when
   * the title carries no recognized prefix. Defaults to `issuePrefixes` when
   * unset (a "Web" prefix doubles as a "web" label), so the common case needs
   * no extra config.
   */
  labels?: string[];
  /**
   * A project icon shown on task/loop cards to tell repos apart at a glance.
   * Either an absolute http(s) URL or a local file path (e.g. a dev-build
   * favicon). Served to the UI via `/api/repos/:name/icon`.
   */
  icon?: string;
  /**
   * Accent color for this project, used as a very subtle tint on the icon
   * "backdrop tray" of its loop/task cards. A CSS color string (typically
   * `#rrggbb`). When unset the UI derives a default from the project icon's
   * dominant color, so this is only an override — pick one in the Config page's
   * color selector.
   */
  gradient?: string;
  /**
   * Opt this repo into the QA smoke gate. When set, a loop runs `/loop-qa` on
   * the implementation thread once a PR appears (boot the app, drive the
   * affected flow, screenshot) before review, and routes a `fail` back to
   * fixing. Only repos with a `/loop-qa` setup should enable this — today that
   * is the web app only. See autozerts-private/docs/web-app-qa-gate.md.
   */
  qaGate?: boolean;
  /**
   * The local dev-server port `/loop-qa` serves this repo on. The Runner leases
   * it so only one loop binds it at a time, so distinct projects should use
   * distinct ports to QA concurrently (web app `3000`, api-developer-dashboard
   * `5173`). Defaults to the shared {@link QA_PORT} (3000) when unset.
   */
  qaPort?: number;
  /**
   * Filesystem path to this repo's QA Companion Repo — a second local clone a
   * human checks a Loop's Task Branch out into to run a real QA build (today
   * only `zerion-wallet-extension`). When set, the Loop Detail page shows a
   * QA-build control that checks out / pulls the Task Branch there. The engine
   * never writes to it. Mirrors the Raycast command's `extensionQaRepoPath`.
   */
  qaCompanionPath?: string;
  /**
   * Optional shared staging deploy URL for this repo (e.g. an internal host
   * behind a VPN). Shown as an "unstable" quick link on the Loop Detail page
   * because other branches can overwrite it.
   */
  stagingUrl?: string;
}

export function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function int(value: string | undefined, fallback: number): number {
  const n = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Parse a REPOS-shaped JSON array, dropping entries missing required fields. */
export function parseReposJson(raw: string | undefined | null): RepoConfig[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return (parsed as RepoConfig[]).filter((r) => r.name && r.localPath && r.defaultBranch);
  } catch {
    return null;
  }
}

/**
 * Validate a repos array bound for persistence. Returns a cleaned copy (trimmed
 * strings, empty optional arrays dropped) or throws with a user-facing message —
 * the API surfaces that message as a 400 so the web editor can show it.
 */
export function validateRepos(input: unknown): RepoConfig[] {
  if (!Array.isArray(input)) throw new Error("repos must be an array");
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const r = raw as Partial<RepoConfig>;
    const where = r.name ? `"${r.name}"` : `#${i + 1}`;
    const name = (r.name ?? "").trim();
    const localPath = (r.localPath ?? "").trim();
    const defaultBranch = (r.defaultBranch ?? "").trim();
    if (!name) throw new Error(`Repo ${where}: name is required`);
    if (!localPath) throw new Error(`Repo ${where}: local path is required`);
    if (!defaultBranch) throw new Error(`Repo ${where}: default branch is required`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate repo name "${name}"`);
    seen.add(key);

    const list = (v: unknown): string[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      const cleaned = v.map((s) => String(s).trim()).filter(Boolean);
      return cleaned.length ? cleaned : undefined;
    };
    const icon = (r.icon ?? "").trim();
    const gradient = (r.gradient ?? "").trim();
    const qaCompanionPath = (r.qaCompanionPath ?? "").trim();
    const stagingUrl = (r.stagingUrl ?? "").trim();
    const repo: RepoConfig = { name, localPath, defaultBranch };
    const issuePrefixes = list(r.issuePrefixes);
    const labels = list(r.labels);
    if (issuePrefixes) repo.issuePrefixes = issuePrefixes;
    if (labels) repo.labels = labels;
    if (icon) repo.icon = icon;
    if (gradient) repo.gradient = gradient;
    if (r.qaGate === true) repo.qaGate = true;
    if (r.qaPort != null && (r.qaPort as unknown) !== "") {
      const p = Number(r.qaPort);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        throw new Error(`Repo ${where}: qaPort must be a port number (1–65535)`);
      }
      repo.qaPort = p;
    }
    if (qaCompanionPath) repo.qaCompanionPath = qaCompanionPath;
    if (stagingUrl) repo.stagingUrl = stagingUrl;
    return repo;
  });
}

const env = process.env;

const dataDir = expandHome(env.DATA_DIR ?? "~/.ai-runner/data");

/**
 * The editable runner config. The repos array is the source of truth for
 * repo→issue matching and is read here; env `REPOS` is only the seed used when
 * no config.json exists yet. See ADR-0003.
 */
const configJsonPath = path.join(dataDir, "config.json");

interface ConfigFile {
  version: number;
  repos: RepoConfig[];
  /** Config-default Claude model id (a T3 slug) used when a loop chooses none. */
  defaultModel?: string;
}

const DEFAULT_CLAUDE_MODEL = "claude-fable-5";

/** Read config.json once at boot, or {} when missing/unreadable. */
function readConfigFile(): Partial<ConfigFile> {
  try {
    return JSON.parse(fs.readFileSync(configJsonPath, "utf8")) as ConfigFile;
  } catch {
    // Missing or unreadable config.json — fall through to the env seeds.
    return {};
  }
}

const configFile = readConfigFile();

/**
 * Repos load order (config.json wins): a valid `repos` array in config.json is
 * authoritative; otherwise fall back to parsing env `REPOS` as the seed. No file
 * is written on boot — config.json is created lazily on the first {@link saveRepos}.
 */
function loadRepos(): RepoConfig[] {
  if (Array.isArray(configFile.repos)) {
    return configFile.repos.filter((r) => r.name && r.localPath && r.defaultBranch);
  }
  return parseReposJson(env.REPOS) ?? [];
}

/**
 * Default-model load order (config.json wins): a persisted `defaultModel` is
 * authoritative; otherwise fall back to env `CLAUDE_MODEL`, then the built-in.
 */
function loadDefaultModel(): string {
  const persisted = typeof configFile.defaultModel === "string" ? configFile.defaultModel.trim() : "";
  return persisted || env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
}

export const config = {
  port: int(env.PORT, 4777),
  linearApiKey: env.LINEAR_API_KEY ?? "",
  repos: loadRepos(),
  claudeModel: loadDefaultModel(),
  dataDir,
  logFile: expandHome(env.LOG_FILE ?? "~/.ai-runner/logs/ai-runner.log"),
  maxParallelLoops: int(env.MAX_PARALLEL_LOOPS, 10),
  maxIterations: int(env.MAX_ITERATIONS, 5),
};

export const CONFIG_JSON_PATH = configJsonPath;

/** Write the editable config (repos + default model) atomically (temp + rename). */
function persistConfig() {
  fs.mkdirSync(dataDir, { recursive: true });
  const payload: ConfigFile = { version: 1, repos: config.repos, defaultModel: config.claudeModel };
  const tmp = `${configJsonPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmp, configJsonPath);
}

/**
 * Validate, persist, and hot-apply a new repos array. The in-memory
 * `config.repos` is replaced so matching reflects the edit with no daemon
 * restart. Throws on validation failure.
 */
export function saveRepos(repos: unknown): RepoConfig[] {
  const validated = validateRepos(repos);
  config.repos = validated;
  persistConfig();
  return validated;
}

/**
 * Persist and hot-apply the config-default Claude model. The in-memory
 * `config.claudeModel` is replaced so new loops pick it up with no daemon
 * restart. Throws when the model id is missing.
 */
export function saveDefaultModel(model: unknown): string {
  if (typeof model !== "string" || !model.trim()) throw new Error("model is required");
  config.claudeModel = model.trim();
  persistConfig();
  return config.claudeModel;
}

export function findRepo(name: string): RepoConfig | undefined {
  return config.repos.find((r) => r.name === name);
}

/** The runner-hosted URL serving a repo's project icon, or null if none is configured. */
export function repoIconUrl(repo: RepoConfig | undefined): string | null {
  return repo?.icon ? `/api/repos/${encodeURIComponent(repo.name)}/icon` : null;
}
