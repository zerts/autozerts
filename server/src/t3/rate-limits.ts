/**
 * Account usage / rate-limit windows — the same data Claude Code's `/usage`
 * shows (current session, weekly all-models, weekly Sonnet, plus extra-usage
 * overage). It comes from Anthropic's OAuth usage endpoint, authenticated with
 * the Claude Code OAuth access token stored in the macOS login Keychain under
 * the `Claude Code-credentials` item (`claudeAiOauth.accessToken`).
 *
 * We read the token at request time and call the endpoint directly; results are
 * cached briefly to avoid hammering the API and re-hitting the Keychain. The
 * token is refreshed by Claude Code itself — if it has expired (and Claude Code
 * isn't running to refresh it), the call 401s and we report it as unavailable
 * rather than guessing.
 */
import { execFile } from "node:child_process";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const OAUTH_BETA = "oauth-2025-04-20";
const CACHE_TTL_MS = 60_000;

export interface RateLimitWindow {
  /** "session" | "weekly_all" | "weekly_scoped" | … */
  kind: string;
  /** "session" | "weekly" — coarse grouping. */
  group: string;
  /** Percent of the window consumed (0–100). */
  percent: number;
  /** "normal" | "warning" | … (provider-assigned). */
  severity: string;
  /** ISO timestamp the window resets, or null. */
  resetsAt: string | null;
  /** Model this window is scoped to (e.g. "Sonnet"), or null for all-models. */
  scopeModel: string | null;
  isActive: boolean;
}

export interface ExtraUsage {
  /** Percent of the extra-usage (overage) allowance consumed. */
  utilization: number;
  usedCredits: number;
  monthlyLimit: number;
  /** Minor-unit divisor: credits / 10^decimalPlaces = currency amount. */
  decimalPlaces: number;
  currency: string;
}

export interface RateLimits {
  /** False when the token is missing/expired or the request failed. */
  available: boolean;
  /** Why it's unavailable (shown in the UI), or null when available. */
  reason: string | null;
  windows: RateLimitWindow[];
  extra: ExtraUsage | null;
  generatedAt: string;
}

let cache: { at: number; value: RateLimits } | null = null;

export async function readRateLimits(): Promise<RateLimits> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const value = await fetchRateLimits();
  // Only cache good readings — a failure should clear on the next refresh.
  if (value.available) cache = { at: Date.now(), value };
  else cache = null;
  return value;
}

function readClaudeOAuthToken(): Promise<{ accessToken: string; expiresAt: number } | null> {
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const oauth = (JSON.parse(stdout) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } })
            .claudeAiOauth;
          if (!oauth?.accessToken) return resolve(null);
          resolve({ accessToken: oauth.accessToken, expiresAt: Number(oauth.expiresAt) || 0 });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

async function fetchRateLimits(): Promise<RateLimits> {
  const generatedAt = new Date().toISOString();
  const fail = (reason: string): RateLimits => ({
    available: false,
    reason,
    windows: [],
    extra: null,
    generatedAt,
  });

  const creds = await readClaudeOAuthToken();
  if (!creds) return fail("Sign in to Claude Code to see usage");

  let res: Response;
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${creds.accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(6000),
    });
  } catch (e) {
    return fail(`Usage request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 401 || res.status === 403) return fail("Claude Code session expired — open Claude Code to refresh");
  if (!res.ok) return fail(`Usage request failed: ${res.status}`);

  let body: UsageResponse;
  try {
    body = (await res.json()) as UsageResponse;
  } catch {
    return fail("Malformed usage response");
  }

  const windows: RateLimitWindow[] = (body.limits ?? []).map((l) => ({
    kind: String(l?.kind ?? "unknown"),
    group: String(l?.group ?? ""),
    percent: typeof l?.percent === "number" ? l.percent : 0,
    severity: String(l?.severity ?? "normal"),
    resetsAt: typeof l?.resets_at === "string" ? l.resets_at : null,
    scopeModel: l?.scope?.model?.display_name ?? null,
    isActive: l?.is_active === true,
  }));

  const eu = body.extra_usage;
  const extra: ExtraUsage | null =
    eu && eu.is_enabled
      ? {
          utilization: typeof eu.utilization === "number" ? eu.utilization : 0,
          usedCredits: typeof eu.used_credits === "number" ? eu.used_credits : 0,
          monthlyLimit: typeof eu.monthly_limit === "number" ? eu.monthly_limit : 0,
          decimalPlaces: typeof eu.decimal_places === "number" ? eu.decimal_places : 2,
          currency: String(eu.currency ?? "USD"),
        }
      : null;

  return { available: true, reason: null, windows, extra, generatedAt };
}

interface UsageResponse {
  limits?: Array<{
    kind?: string;
    group?: string;
    percent?: number;
    severity?: string;
    resets_at?: string | null;
    scope?: { model?: { display_name?: string | null } | null } | null;
    is_active?: boolean;
  }>;
  extra_usage?: {
    is_enabled?: boolean;
    utilization?: number;
    used_credits?: number;
    monthly_limit?: number;
    decimal_places?: number;
    currency?: string;
  } | null;
}
