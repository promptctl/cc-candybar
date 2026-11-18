import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  arbitrateSocket,
  readLease,
  writeLease,
  type LeaseRead,
} from "../src/daemon/socket-lease";
import {
  readOwnStartTime,
  type Liveness,
} from "../src/daemon/process-fingerprint";
import { processProbe } from "./helpers/host";

// ─── Pure arbitration: full input-space enumeration ──────────────────────────
//
// [LAW:effects-at-boundaries] arbitrateSocket is a pure fold over (lease read,
// injected liveness). Every branch is exercised here with a stub predicate and
// no real processes — this is the load-bearing correctness test for the
// socket-theft fix (the integration tests below only prove the wiring).

describe("arbitrateSocket (pure decision)", () => {
  const ME = 1;
  const SAME = async (): Promise<Liveness> => ({ live: true, why: "is alive" });
  const NOT_SAME = async (): Promise<Liveness> => ({
    live: false,
    why: "is gone",
  });
  const owned = (pid: number, startTime: string | null = "st"): LeaseRead => ({
    kind: "owned",
    pid,
    startTime,
  });

  test("owned + same-live → attach-and-exit (a live owner holds the socket)", async () => {
    const d = await arbitrateSocket(owned(4242), ME, SAME);
    expect(d.kind).toBe("attach-and-exit");
    expect(d.reason).toContain("4242");
  });

  // [LAW:nothing-unseen] The decision's line says what the fold found, so an
  // owner spared because its start time could not be read says so.
  // No other live process holds our pid, so a lease naming it is stale,
  // whatever liveness would say of the pid (it is alive: it is us).
  test("a lease naming our own pid → reclaim, without asking liveness", async () => {
    const isSame = jest.fn(SAME);
    const d = await arbitrateSocket(owned(ME), ME, isSame);
    expect(d.kind).toBe("reclaim");
    expect(isSame).not.toHaveBeenCalled();
  });

  test("the reason carries the liveness fold's why", async () => {
    const d = await arbitrateSocket(owned(4242), ME, async () => ({
      live: true,
      why: "is alive, start time unreadable: EACCES",
    }));
    expect(d.reason).toBe(
      "owner pid=4242 is alive, start time unreadable: EACCES",
    );
  });

  test("owned + not-same → reclaim (owner crashed OR pid recycled)", async () => {
    const d = await arbitrateSocket(owned(4242), ME, NOT_SAME);
    expect(d.kind).toBe("reclaim");
    expect(d.reason).toContain("4242");
  });

  test("absent → reclaim (no lease; stale socket, no live owner)", async () => {
    // The liveness predicate must not even be consulted when there is no pid.
    const isSame = jest.fn(SAME);
    const d = await arbitrateSocket({ kind: "absent" }, ME, isSame);
    expect(d.kind).toBe("reclaim");
    expect(isSame).not.toHaveBeenCalled();
  });

  test("unreadable → reclaim (cannot prove a live owner)", async () => {
    const isSame = jest.fn(SAME);
    const d = await arbitrateSocket(
      { kind: "unreadable", detail: "bad JSON" },
      ME,
      isSame,
    );
    expect(d.kind).toBe("reclaim");
    expect(d.reason).toContain("bad JSON");
    expect(isSame).not.toHaveBeenCalled();
  });

  // The predicate receives BOTH the pid and the lease's start-time token — the
  // process-identity pair that lets a recycled pid be distinguished from the
  // original owner (RESIDUAL 1). arbitrateSocket forwards them verbatim; the
  // liveness fold (process-fingerprint) decides.
  test("forwards pid AND startTime to the injected predicate", async () => {
    const isSame = jest.fn(SAME);
    await arbitrateSocket(owned(999, "Thu Jul  9 05:04:25 2026"), ME, isSame);
    expect(isSame).toHaveBeenCalledWith(999, "Thu Jul  9 05:04:25 2026");
  });

  // [LAW:no-silent-failure] The failure DIRECTION is the whole safety argument:
  // a busy-but-live daemon (backlog full — the ECONNREFUSED case that fooled the
  // old connect probe) is judged by process identity, which is load-independent.
  // As long as the SAME process is alive, arbitration attaches-and-exits
  // regardless of whether it is currently accepting connections.
  test("liveness comes only from the injected predicate, never from connect", async () => {
    const record = owned(999);
    expect((await arbitrateSocket(record, ME, SAME)).kind).toBe(
      "attach-and-exit",
    );
    expect((await arbitrateSocket(record, ME, NOT_SAME)).kind).toBe("reclaim");
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

  test("readLease: absent file → absent", async () => {
    expect(readLease(leasePath)).toEqual({ kind: "absent" });
  });

  test("writeLease → readLease round-trips the owner pid AND start-time", async () => {
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

  // [LAW:one-source-of-truth] Every release reads the lease, and a release
  // before this one judges its owner by raw token equality against `ps`. A
  // lease the daemon writes today must still read as its live owner to that
  // rule, or an older daemon beside a newer one would reclaim its live socket.
  test("a lease written today names its owner under the old rule (raw token equality with ps)", async () => {
    const own = await processProbe.startTime(process.pid);
    if (own.kind !== "start") throw new Error(`no start time: ${own.detail}`);
    writeLease(leasePath, {
      pid: process.pid,
      version: 2,
      binPath: undefined,
      startTime: await readOwnStartTime(process.pid, processProbe.startTime),
    });
    const raw = JSON.parse(fs.readFileSync(leasePath, "utf8")) as {
      startTime: unknown;
    };
    expect(raw.startTime === own.token).toBe(true);
  });

  // Backward-compat: an OLD lease with no startTime key reads as unfingerprinted
  // (null), NOT unreadable — so an in-place upgrade doesn't force a false reclaim.
  test("readLease: a lease missing startTime entirely → owned with null", async () => {
    fs.writeFileSync(leasePath, JSON.stringify({ pid: 55, version: 2 }));
    expect(readLease(leasePath)).toEqual({
      kind: "owned",
      pid: 55,
      startTime: null,
    });
  });

  test("readLease: non-JSON → unreadable, not a crash", async () => {
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
});
