/**
 * config.example.ts — template for project-specific configuration
 *
 * This file is committed to the repository as a template.
 * To get started:
 *   cp src/config.example.ts src/config.ts
 * Then fill in the values below for your own machine and organisation.
 *
 * src/config.ts is listed in .gitignore so your personal values are never
 * committed. None of these values are secrets — put API keys and tokens in
 * your .env file instead.
 */

// ---------------------------------------------------------------------------
// Node / runtime paths
// ---------------------------------------------------------------------------

/**
 * Path to the directory that contains your `node` binary.
 *
 * Raycast extensions are launched as sandboxed macOS apps and do not inherit
 * the shell's PATH, so the node runtime must be located explicitly.
 *
 * To find the right value for your machine, run this in your terminal:
 *   dirname $(which node)
 *
 * If you use nvm, it will look something like:
 *   /Users/<you>/.nvm/versions/node/v22.14.0/bin
 * If you use Homebrew:
 *   /opt/homebrew/bin
 */
export const NODE_BIN_PATH = "/usr/local/bin";

// ---------------------------------------------------------------------------
// Development / local paths
// ---------------------------------------------------------------------------

/**
 * Fallback absolute path to the .env file.
 *
 * When the extension is running in development mode, Raycast's asset path
 * resolution may not work as expected. This path is used as a fallback so
 * that dotenv can still locate and load your credentials.
 *
 * Set this to the absolute path of the .env file in your local checkout:
 *   /Users/<you>/path/to/raycast-extension/.env
 */
export const FALLBACK_ENV_PATH = "/Users/<you>/path/to/raycast-extension/.env";

// ---------------------------------------------------------------------------
// GitHub organisation
// ---------------------------------------------------------------------------

/**
 * Your GitHub organisation login or personal username.
 *
 * Used to construct release URLs and GitHub Desktop deep links in QA notes.
 * Example: "my-org" → https://github.com/my-org/<repo>/releases/tag/...
 */
export const GITHUB_OWNER = "my-org";

// ---------------------------------------------------------------------------
// Repository names
// ---------------------------------------------------------------------------

/**
 * Names of the repositories this extension has special knowledge about.
 *
 * These values are compared against `pr.base.repo.name` (the GitHub API field)
 * and against repo entries in your REPOS .env config to enable per-repo
 * features. Update them to match the repository names in your organisation.
 */
export const REPOS = {
  /**
   * The main wallet / app extension repository.
   *
   * Enables:
   * - QA branch tracking in the PR list (shows whether the QA companion repo
   *   has the PR branch checked out and whether it is up-to-date)
   * - Release URL and GitHub Desktop deep-link generation in QA notes
   */
  extension: "my-extension-repo",

  /**
   * The QA companion repository.
   *
   * This is the repo that testers check out to run release candidates against.
   * Its name is embedded in the "Open in GitHub Desktop" deep link that the
   * QA note builder generates.
   */
  extensionQa: "my-extension-repo-qa",

  /**
   * The frontend web-app repository.
   *
   * Enables preview URL detection: when a deploy-bot posts a comment of the
   * form "deployed to https://..." on a PR in this repo, the extension picks
   * up the URL and surfaces it as an accessory icon in the PR list.
   */
  frontend: "my-frontend-repo",
} as const;
