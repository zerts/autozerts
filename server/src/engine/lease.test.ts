import { describe, expect, test } from "bun:test";
import { acquirePortLease, portLeaseHolder, releaseLeasesForLoop, releasePortLease } from "./lease";

describe("port lease", () => {
  test("first acquirer wins, a second loop is denied until release", () => {
    const port = 4001;
    expect(acquirePortLease(port, "loop-a")).toBe(true);
    expect(acquirePortLease(port, "loop-b")).toBe(false);
    expect(portLeaseHolder(port)).toBe("loop-a");
    releasePortLease(port, "loop-a");
    expect(portLeaseHolder(port)).toBeNull();
    expect(acquirePortLease(port, "loop-b")).toBe(true);
  });

  test("the holder can renew idempotently", () => {
    const port = 4002;
    expect(acquirePortLease(port, "loop-a")).toBe(true);
    expect(acquirePortLease(port, "loop-a")).toBe(true);
    releasePortLease(port, "loop-a");
  });

  test("release by a non-holder is a no-op", () => {
    const port = 4003;
    acquirePortLease(port, "loop-a");
    releasePortLease(port, "loop-b");
    expect(portLeaseHolder(port)).toBe("loop-a");
    releaseLeasesForLoop("loop-a");
  });

  test("a stale holder is reclaimed", () => {
    const port = 4004;
    expect(acquirePortLease(port, "loop-a", 0)).toBe(true);
    // 31 minutes later, loop-a never released — loop-b reclaims it.
    expect(acquirePortLease(port, "loop-b", 31 * 60_000)).toBe(true);
    expect(portLeaseHolder(port)).toBe("loop-b");
    releaseLeasesForLoop("loop-b");
  });

  test("releaseLeasesForLoop clears every port a loop holds", () => {
    acquirePortLease(5001, "loop-a");
    acquirePortLease(5002, "loop-a");
    releaseLeasesForLoop("loop-a");
    expect(portLeaseHolder(5001)).toBeNull();
    expect(portLeaseHolder(5002)).toBeNull();
  });
});
