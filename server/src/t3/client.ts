/**
 * T3 Code dispatch client: signs short-lived websocket tickets with the local
 * HMAC key and sends orchestration commands over the WS RPC
 * (`orchestration.dispatchCommand`). Ported from the Raycast extension's
 * t3code.ts onto Bun's built-in WebSocket.
 */
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { T3_USER_DATA, readActiveSession, readServerRuntime } from "./state";

const SIGNING_KEY_PATH = path.join(T3_USER_DATA, "secrets", "server-signing-key.bin");

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: Record<string, unknown>;
}

export interface DispatchNewThreadParams {
  threadId: string;
  projectId: string;
  title: string;
  branch: string;
  baseBranch: string;
  projectCwd: string;
  modelSelection: ModelSelection;
  firstMessage: string;
  messageId: string;
}

export interface DispatchExistingThreadTurnParams {
  threadId: string;
  text: string;
  messageId: string;
}

async function readSigningKey(): Promise<Buffer> {
  try {
    return await fs.readFile(SIGNING_KEY_PATH);
  } catch {
    throw new Error("T3 Code signing key not found — sign in to T3 Code first");
  }
}

function signWithKey(payload: string, signingKey: Buffer): string {
  return crypto.createHmac("sha256", signingKey).update(payload).digest("base64url");
}

/**
 * Sign a short-lived `kind:"websocket"` token. The `/ws` upgrade route reads it
 * from the `wsTicket` query param and verifies it with the same HMAC key.
 */
async function signWebSocketToken(): Promise<string> {
  const session = readActiveSession();
  const signingKey = await readSigningKey();

  const now = Date.now();
  const exp = Math.min(session.expiresAtMs, now + 5 * 60 * 1000);
  const claims = { v: 1, kind: "websocket", sid: session.sessionId, iat: now, exp };

  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${signWithKey(payload, signingKey)}`;
}

/**
 * Sign a `kind:"session"` bearer token for the active T3 session. T3 verifies
 * the HMAC signature, the `exp` claim, and that the `sid` still exists in its
 * auth_sessions table — scopes come from the token claims, so we can grant the
 * administrative set needed to mint pairing credentials. Mirrors the
 * `wsTicket` flow, just with session claims instead of websocket claims.
 */
async function signSessionToken(scopes: readonly string[]): Promise<string> {
  const session = readActiveSession();
  const signingKey = await readSigningKey();

  const now = Date.now();
  const exp = Math.min(session.expiresAtMs, now + 5 * 60 * 1000);
  const claims = {
    v: 1,
    kind: "session",
    sid: session.sessionId,
    sub: session.subject,
    scopes,
    method: "bearer-access-token",
    iat: now,
    exp,
  };

  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${signWithKey(payload, signingKey)}`;
}

// Administrative scope set: standard client scopes plus access:read/write and
// relay:write. `access:write` is what the pairing-token endpoint requires.
const T3_ADMIN_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
  "access:read",
  "access:write",
  "relay:write",
] as const;

/**
 * Mint a one-time pairing credential via T3's auth API. The runner redeems it
 * server-side (`POST /api/auth/browser-session`) and forwards the resulting
 * session cookie to the browser, so a thread link lands authenticated with no
 * gate (see `/api/t3/threads/:id/open` in api.ts). Alternatively, opening
 * `/pair#token=<credential>` in a browser lets the SPA redeem it directly
 * (mirrors T3's own startup `issueStartupPairingUrl`) — but that lands on the
 * app home, and the token must hit `/pair` directly since gated deep routes
 * bounce to `/pair` with the URL fragment stripped. Credentials are single-use
 * and expire after ~5 minutes, so mint one per click.
 */
export async function issuePairingToken(label = "ai-runner"): Promise<string> {
  const runtime = readServerRuntime();
  const token = await signSessionToken(T3_ADMIN_SCOPES);

  const res = await fetch(`${runtime.origin}/api/auth/pairing-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) {
    throw new Error(`T3 pairing-token request failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { credential?: string };
  if (!data.credential) throw new Error("T3 pairing-token response missing credential");
  return data.credential;
}

const ORCHESTRATION_DISPATCH_METHOD = "orchestration.dispatchCommand";
const WS_DISPATCH_TIMEOUT_MS = 30_000;

interface RpcExitFrame {
  _tag: "Exit";
  requestId: string;
  exit:
    | { _tag: "Success"; value: unknown }
    | {
        _tag: "Failure";
        cause: Array<
          | { _tag: "Fail"; error: { message?: string; _tag?: string } }
          | { _tag: "Die"; defect: unknown }
          | { _tag: "Interrupt"; fiberId: number | undefined }
        >;
      };
}

function describeRpcFailure(exit: Extract<RpcExitFrame["exit"], { _tag: "Failure" }>): string {
  for (const entry of exit.cause) {
    if (entry._tag === "Fail" && entry.error?.message) return entry.error.message;
    if (entry._tag === "Die") return `defect: ${JSON.stringify(entry.defect)}`;
  }
  return "unknown error";
}

async function dispatchOrchestrationCommand(command: Record<string, unknown>): Promise<void> {
  const runtime = readServerRuntime();
  const token = await signWebSocketToken();

  const wsOrigin = runtime.origin.replace(/^http/, "ws");
  const url = `${wsOrigin}/ws?wsTicket=${encodeURIComponent(token)}`;
  const requestId = "1";

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;

    const timer = setTimeout(() => finish(new Error("T3 Code dispatch timed out")), WS_DISPATCH_TIMEOUT_MS);

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (error) reject(error);
      else resolve();
    }

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          _tag: "Request",
          id: requestId,
          tag: ORCHESTRATION_DISPATCH_METHOD,
          payload: command,
          headers: [], // effect rpc requires array-of-pairs, not an object
        }),
      );
    };

    ws.onmessage = (event) => {
      let frame: RpcExitFrame | { _tag: string };
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return; // ignore unparseable frames (e.g. Pong)
      }
      if (frame._tag !== "Exit") return;
      const exitFrame = frame as RpcExitFrame;
      if (exitFrame.requestId !== requestId) return;
      if (exitFrame.exit._tag === "Success") finish();
      else finish(new Error(`T3 Code dispatch failed: ${describeRpcFailure(exitFrame.exit)}`));
    };

    ws.onerror = () => finish(new Error("T3 Code websocket error"));
    ws.onclose = () => finish(new Error("T3 Code closed the connection before responding"));
  });
}

export async function dispatchNewThread(params: DispatchNewThreadParams): Promise<void> {
  const now = new Date().toISOString();
  await dispatchOrchestrationCommand({
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId: params.threadId,
    message: {
      messageId: params.messageId,
      role: "user",
      text: params.firstMessage,
      attachments: [],
    },
    modelSelection: params.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: now,
    bootstrap: {
      createThread: {
        projectId: params.projectId,
        title: params.title,
        modelSelection: params.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: params.branch,
        worktreePath: null,
        createdAt: now,
      },
      prepareWorktree: {
        projectCwd: params.projectCwd,
        baseBranch: params.baseBranch,
        branch: params.branch,
      },
      runSetupScript: true,
    },
  });
}

export async function dispatchExistingThreadTurn(params: DispatchExistingThreadTurnParams): Promise<void> {
  await dispatchOrchestrationCommand({
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId: params.threadId,
    message: {
      messageId: params.messageId,
      role: "user",
      text: params.text,
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
}

export async function dispatchTurnInterrupt(threadId: string): Promise<void> {
  await dispatchOrchestrationCommand({
    type: "thread.turn.interrupt",
    commandId: randomUUID(),
    threadId,
    createdAt: new Date().toISOString(),
  });
}

export async function dispatchThreadDelete(threadId: string): Promise<void> {
  await dispatchOrchestrationCommand({
    type: "thread.delete",
    commandId: randomUUID(),
    threadId,
    createdAt: new Date().toISOString(),
  });
}

export function openT3CodeApp(): void {
  exec('open -a "T3 Code (Alpha)"', () => {
    // Non-fatal — dispatch already happened.
  });
}

export function newId(): string {
  return randomUUID();
}
