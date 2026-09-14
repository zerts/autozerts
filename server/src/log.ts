import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

fs.mkdirSync(path.dirname(config.logFile), { recursive: true });

function write(level: "info" | "warn" | "error", parts: unknown[]) {
  const line = `${new Date().toISOString()} [${level}] ${parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ")}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(config.logFile, line);
  } catch {
    // logging must never crash the runner
  }
}

export const log = {
  info: (...parts: unknown[]) => write("info", parts),
  warn: (...parts: unknown[]) => write("warn", parts),
  error: (...parts: unknown[]) => write("error", parts),
};
