import { afterEach, describe, expect, mock, test } from "bun:test";
import type { T3Turn, ThreadSessionStatus } from "./state";

const DISPATCHED_AT = "2026-06-18T16:03:31.000Z";
const MSG_ID = "msg-1";

interface StateStub {
  session: ThreadSessionStatus | null;
  turns: T3Turn[];
  messageExists: boolean;
}

function stubState(stub: StateStub) {
  mock.module("./state", () => ({
    threadSessionStatus: () => stub.session,
    turnsForThread: () => stub.turns,
    hasActiveTurns: () => stub.turns.some((t) => t.state === "pending" || t.state === "running"),
    messageExists: () => stub.messageExists,
  }));
}

function turn(state: T3Turn["state"], requestedAt: string, completedAt: string | null = null): T3Turn {
  return { turnId: "t-" + requestedAt, state, requestedAt, startedAt: requestedAt, completedAt };
}

const session = (status: string, updatedAt = DISPATCHED_AT): ThreadSessionStatus => ({
  status,
  activeTurnId: null,
  lastError: null,
  updatedAt,
});

afterEach(() => {
  mock.restore();
});

describe("checkSettlement", () => {
  async function check() {
    const { checkSettlement } = await import("./watch");
    return checkSettlement("thread-1", DISPATCHED_AT, MSG_ID);
  }

  test("waits while the session is running", async () => {
    stubState({ session: session("running"), turns: [turn("running", DISPATCHED_AT)], messageExists: true });
    expect(await check()).toBeNull();
  });

  test("settles completed once the session is idle, ignoring a zombie running turn", async () => {
    // The dispatched review turn finished, but a later unrelated turn is stuck
    // `running` on the same thread. The idle session row is authoritative.
    stubState({
      session: session("ready", "2026-06-18T16:11:31.000Z"),
      turns: [
        turn("completed", "2026-06-18T16:03:31.000Z", "2026-06-18T16:03:38.000Z"),
        turn("running", "2026-06-18T16:09:41.000Z"),
      ],
      messageExists: true,
    });
    expect(await check()).toEqual({
      outcome: "completed",
      turns: expect.any(Array),
    });
  });

  test("surfaces a session error newer than the dispatch", async () => {
    stubState({
      session: session("error", "2026-06-18T16:04:00.000Z"),
      turns: [turn("running", DISPATCHED_AT)],
      messageExists: true,
    });
    expect((await check())?.outcome).toBe("error");
  });

  test("falls back to turn rows when there is no session row", async () => {
    stubState({ session: null, turns: [turn("running", DISPATCHED_AT)], messageExists: true });
    expect(await check()).toBeNull();
  });
});
