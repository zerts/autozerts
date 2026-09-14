import fs from "node:fs";
import path from "node:path";
import { app } from "./api";
import { config } from "./config";
import { RUNTIME_JSON_PATH } from "./data-paths";
import { startEngine } from "./engine/engine";
import { log } from "./log";

fs.mkdirSync(config.dataDir, { recursive: true });

// Serve the built web UI (web/dist) for any non-API route.
const webDist = path.resolve(import.meta.dir, "../../web/dist");
app.get("*", async (c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
  const requested = path.join(webDist, c.req.path === "/" ? "index.html" : c.req.path);
  const file = Bun.file(requested);
  if (await file.exists()) return new Response(file);
  const index = Bun.file(path.join(webDist, "index.html"));
  if (await index.exists()) return new Response(index); // SPA fallback
  return c.text("ai-runner is up — web UI not built yet (bun run build:web)", 200);
});

// Written on boot so external clients (Raycast) can discover the live port,
// mirroring how T3 Code publishes server-runtime.json.
fs.writeFileSync(
  RUNTIME_JSON_PATH,
  JSON.stringify({ version: 1, pid: process.pid, port: config.port, startedAt: new Date().toISOString() }),
);

startEngine();
log.info(`ai-runner listening on http://127.0.0.1:${config.port}`);

export default {
  port: config.port,
  hostname: "127.0.0.1",
  fetch: app.fetch,
  idleTimeout: 120, // SSE streams ping every 25s
};
