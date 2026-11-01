import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  arbitrateSocket,
  readLease,
  removeLeaseIfOwned,
  writeLease,
  type LeaseRead,
} from "../src/daemon/socket-lease";

// ─── Pure arbitration: full input-space enumeration ──────────────────────────
//
// [LAW:effects-at-boundaries] arbitrateSocket is a pure fold over (lease read,
// injected liveness). Every branch is exercised here with a stub predicate and
// no real processes — this is the load-bearing correctness test for the
// socket-theft fix (the integration tests below only prove the wiring).

describe("arbitrateSocket (pure decision)", () => {
  const SAME = (): boolean => true;
  const NOT_SAME = (): boolean => false;
  const owned = (pid: number, startTime: string | null = "st"): LeaseRead => ({
    kind: "owned",
    pid,
    startTime,
  });

  test("owned + same-live → attach-and-exit (a live owner holds the socket)", () => {
    const d = arbitrateSocket(owned(4242), SAME);
    expect(d.kind).toBe("attach-and-exit");
    expect(d.reason).toContain("4242");
  });

  test("owned + not-same → reclaim (owner crashed OR pid recycled)", () => {
    const d = arbitrateSocket(owned(4242), NOT_SAME);
    expect(d.kind).toBe("reclaim");
    expect(d.reason).toContain("4242");
  });

  test("absent → reclaim (no lease; stale socket, no live owner)", () => {
    // The liveness predicate must not even be consulted when there is no pid.
    const isSame = jest.fn(() => true);
    const d = arbitrateSocket({ kind: "absent" }, isSame);
    expect(d.kind).toBe("reclaim");
    expect(isSame).not.toHaveBeenCalled();
  });

  test("unreadable → reclaim (cannot prove a live owner)", () => {
    const isSame = jest.fn(() => true);
    const d = arbitrateSocket(
      { kind: "unreadable", detail: "bad JSON" },
      isSame,
    );
    expect(d.kind).toBe("reclaim");
    expect(d.reason).toContain("bad JSON");
    expect(isSame).not.toHaveBeenCalled();
  });

  // The predicate receives BOTH the pid and the lease's start-time token — the
  // process-identity pair that lets a recycled pid be distinguished from the
  // original owner (RESIDUAL 1). arbitrateSocket forwards them verbatim; the
  // sameLiveProcess fold (process-fingerprint) decides.
  test("forwards pid AND startTime to the injected predicate", () => {
    const isSame = jest.fn(() => true);
    arbitrateSocket(owned(999, "Thu Jul  9 05:04:25 2026"), isSame);
    expect(isSame).toHaveBeenCalledWith(999, "Thu Jul  9 05:04:25 2026");
  });

  // [LAW:no-silent-failure] The failure DIRECTION is the whole safety argument:
  // a busy-but-live daemon (backlog full — the ECONNREFUSED case that fooled the
  // old connect probe) is judged by process identity, which is load-independent.
  // As long as the SAME process is alive, arbitration attaches-and-exits
  // regardless of whether it is currently accepting connections.
  test("liveness comes only from the injected predicate, never from connect", () => {
    const record = owned(999);
    expect(arbitrateSocket(record, () => true).kind).toBe("attach-and-exit");
    expect(arbitrateSocket(record, () => false).kind).toBe("reclaim");
  });
});

// ─── Lease file I/O ──────────────────────────────────────────────────────────

describe("lease file I/O", () => {
  let dir: string;
  let leasePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-lease-"));
    leasePath = path.join(dir, "socket.lease");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("readLease: absent file → absent", () => {
    expect(readLease(leasePath)).toEqual({ kind: "absent" });
  });

  test("writeLease → readLease round-trips the owner pid AND start-time", () => {
    const err = writeLease(leasePath, {
      pid: 1234,
      version: 2,
      binPath: "/x/y",
      startTime: "Thu Jul  9 05:04:25 2026",
    });
    expect(err).toBeNull();
    expect(readLease(leasePath)).toEqual({
      kind: "owned",
      pid: 1234,
      startTime: "Thu Jul  9 05:04:25 2026",
    });
    // 0600 — never group/world readable.
    expect(fs.statSync(leasePath).mode & 0o077).toBe(0);
  });

  // A host that could not fingerprint (no `ps`) writes a null start-time; the
  // reader surfaces it as null so sameLiveProcess falls back to kill(pid,0).
  test("writeLease → readLease round-trips a null start-time (unfingerprinted)", () => {
    writeLease(leasePath, {
      pid: 1234,
      version: 2,
      binPath: undefined,
      startTime: null,
    });
    expect(readLease(leasePath)).toEqual({
      kind: "owned",
      pid: 1234,
      startTime: null,
    });
  });

  // Backward-compat: an OLD lease with no startTime key reads as unfingerprinted
  // (null), NOT unreadable — so an in-place upgrade doesn't force a false reclaim.
  test("readLease: a lease missing startTime entirely → owned with null", () => {
    fs.writeFileSync(leasePath, JSON.stringify({ pid: 55, version: 2 }));
    expect(readLease(leasePath)).toEqual({
      kind: "owned",
      pid: 55,
      startTime: null,
    });
  });

  test("readLease: non-JSON → unreadable, not a crash", () => {
    fs.writeFileSync(leasePath, "not json at all");
    const r = readLease(leasePath);
    expect(r.kind).toBe("unreadable");
  });

  test.each([
    ["missing pid", JSON.stringify({ version: 2 })],
    ["non-integer pid", JSON.stringify({ pid: 3.5 })],
    ["non-positive pid", JSON.stringify({ pid: 0 })],
    ["string pid", JSON.stringify({ pid: "123" })],
    // [LAW:no-silent-failure] A present-but-non-string startTime is a lie we
    // refuse to coerce into a fingerprint.
    ["non-string startTime", JSON.stringify({ pid: 9, startTime: 42 })],
  ])("readLease: %s → unreadable", (_label, contents) => {
    fs.writeFileSync(leasePath, contents);
    expect(readLease(leasePath).kind).toBe("unreadable");
  });

  test("removeLeaseIfOwned: removes when the lease names us", () => {
    writeLease(leasePath, {
      pid: 777,
      version: 2,
      binPath: undefined,
      startTime: "t",
    });
    removeLeaseIfOwned(leasePath, 777);
    expect(fs.existsSync(leasePath)).toBe(false);
  });

  // [LAW:one-source-of-truth] A displaced daemon must NOT delete the current
  // owner's lease — that would cascade the theft (next EADDRINUSE reads absent
  // → reclaims the live thief's socket).
  test("removeLeaseIfOwned: keeps a lease owned by someone else", () => {
    writeLease(leasePath, {
      pid: 888,
      version: 2,
      binPath: undefined,
      startTime: "t",
    });
    removeLeaseIfOwned(leasePath, 777);
    expect(readLease(leasePath)).toEqual({
      kind: "owned",
      pid: 888,
      startTime: "t",
    });
  });

  test("removeLeaseIfOwned: no-op on an absent lease", () => {
    expect(() => removeLeaseIfOwned(leasePath, 777)).not.toThrow();
  });
});
