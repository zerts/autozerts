/**
 * Install (or update) the launchd agent so ai-runner starts at login and
 * restarts on crash. Usage: bun run install-agent [--uninstall]
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { config } from "../src/config";

const LABEL = "com.autozerts.ai-runner";
const PLIST_PATH = path.join(os.homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const BUN_PATH = process.execPath;

function run(cmd: string[]): void {
  const proc = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) console.error(`(non-fatal) ${cmd.join(" ")} exited ${proc.exitCode}`);
}

if (process.argv.includes("--uninstall")) {
  run(["launchctl", "bootout", `gui/${process.getuid!()}`, PLIST_PATH]);
  fs.rmSync(PLIST_PATH, { force: true });
  console.log(`Removed ${PLIST_PATH}`);
  process.exit(0);
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BUN_PATH}</string>
    <string>run</string>
    <string>${REPO_ROOT}/server/src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO_ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${config.logFile}</string>
  <key>StandardErrorPath</key><string>${config.logFile}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${path.dirname(BUN_PATH)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;

fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
fs.writeFileSync(PLIST_PATH, plist);

const uid = process.getuid!();
run(["launchctl", "bootout", `gui/${uid}`, PLIST_PATH]); // ignore failure on first install
run(["launchctl", "bootstrap", `gui/${uid}`, PLIST_PATH]);
console.log(`Installed and started ${LABEL}`);
console.log(`  plist: ${PLIST_PATH}`);
console.log(`  logs:  ${config.logFile}`);
console.log(`  url:   http://127.0.0.1:${config.port}`);
