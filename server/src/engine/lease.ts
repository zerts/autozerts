/**
 * Port lease: serializes use of a singleton local port across loops. The web
 * app's QA gate (and any live drive) must bind port 3000 — the backends it
 * talks to (CORS, SIWE session, WalletConnect origins) are pinned there — so
 * only one loop may hold it at a time. The lease is an in-memory holder map; a
 * daemon restart clears it (state is re-derived), and the skill defends against
 * a stray bind anyway (`lsof -ti :3000 | xargs kill -9`), so this is a
 * best-effort serializer, not a hard mutex.
 *
 * See autozerts-private/docs/web-app-qa-gate.md §5.2.
 */

/** The web app's pinned dev-server port — the only port leased today. */
export const QA_PORT = 3000;

/** A holder that's been silent this long is presumed dead and can be reclaimed. */
const STALE_MS = 30 * 60_000;

interface Lease {
  loopId: string;
  at: number;
}

const leases = new Map<number, Lease>();

/**
 * Try to take (or renew) the lease on `port` for `loopId`. Granted when the
 * port is free, already held by this loop (idempotent renew), or held by a
 * holder that's gone stale. Returns false when another live loop holds it.
 */
export function acquirePortLease(port: number, loopId: string, nowMs: number = Date.now()): boolean {
  const held = leases.get(port);
  if (held && held.loopId !== loopId && nowMs - held.at < STALE_MS) return false;
  leases.set(port, { loopId, at: nowMs });
  return true;
}

/** Release `port` if (and only if) `loopId` currently holds it. */
export function releasePortLease(port: number, loopId: string): void {
  if (leases.get(port)?.loopId === loopId) leases.delete(port);
}

/** Release every port held by `loopId` — called on terminal/cancel transitions. */
export function releaseLeasesForLoop(loopId: string): void {
  for (const [port, lease] of leases) {
    if (lease.loopId === loopId) leases.delete(port);
  }
}

/** The loop id currently holding `port`, or null when free. For wait messaging. */
export function portLeaseHolder(port: number): string | null {
  return leases.get(port)?.loopId ?? null;
}
