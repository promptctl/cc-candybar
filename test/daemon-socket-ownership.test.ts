import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkOwnership,
  makeOwnershipWatch,
  readSocketIdentity,
  type IdentityRead,
  type OwnershipWatchDeps,
  type SocketIdentity,
} from "../src/daemon/socket-ownership";
import { type LeaseRead } from "../src/daemon/socket-lease";

const BOUND: SocketIdentity = { dev: 1, ino: 100 };
const MY_PID = 4242;
const HELD: IdentityRead = { kind: "present", identity: { dev: 1, ino: 100 } };
const MINE: LeaseRead = { kind: "owned", pid: MY_PID, startTime: "st" };

// Ownership is the CONJUNCTION of "still my inode" AND "lease still names me".
describe("checkOwnership (pure fold)", () => {
  test("held inode + lease names me → owned", () => {
    expect(checkOwnership(BOUND, HELD, MY_PID, MINE)).toEqual({ kind: "owned" });
  });

  test("present + different inode → displaced", () => {
    const d = checkOwnership(
      BOUND,
      { kind: "present", identity: { dev: 1, ino: 200 } },
      MY_PID,
      MINE,
    );
    expect(d.kind).toBe("displaced");
    expect(d.kind === "displaced" && d.reason).toContain("ino=200");
  });

  test("present + different dev → displaced (dev+ino, not ino alone)", () => {
    const d = checkOwnership(
      BOUND,
      { kind: "present", identity: { dev: 2, ino: 100 } },
      MY_PID,
      MINE,
    );
    expect(d.kind).toBe("displaced");
  });

  test("absent (ENOENT) → displaced", () => {
    const d = checkOwnership(BOUND, { kind: "absent" }, MY_PID, MINE);
    expect(d.kind).toBe("displaced");
    expect(d.kind === "displaced" && d.reason).toContain("ENOENT");
  });

  test("unreadable → displaced (cannot prove ownership → err toward exit)", () => {
    const d = checkOwnership(
      BOUND,
      { kind: "unreadable", detail: "EIO boom" },
      MY_PID,
      MINE,
    );
    expect(d.kind).toBe("displaced");
    expect(d.kind === "displaced" && d.reason).toContain("EIO boom");
  });

  // The lease arm catches what the inode arm cannot: a thief that kept our inode.
  test("held inode BUT lease reassigned to another pid → displaced", () => {
    const d = checkOwnership(BOUND, HELD, MY_PID, {
      kind: "owned",
      pid: 9999,
      startTime: "other",
    });
    expect(d.kind).toBe("displaced");
    expect(d.kind === "displaced" && d.reason).toContain("9999");
  });

  test("held inode BUT lease absent → displaced (no longer hold the authority)", () => {
    const d = checkOwnership(BOUND, HELD, MY_PID, { kind: "absent" });
    expect(d.kind).toBe("displaced");
    expect(d.kind === "displaced" && d.reason).toContain("absent");
  });

  test("held inode BUT lease unreadable → displaced", () => {
    const d = checkOwnership(BOUND, HELD, MY_PID, {
      kind: "unreadable",
      detail: "bad JSON",
    });
    expect(d.kind).toBe("displaced");
    expect(d.kind === "displaced" && d.reason).toContain("unreadable");
  });
});

describe("readSocketIdentity (fs boundary)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-own-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("existing path → present with the real dev+ino", () => {
    const p = path.join(dir, "socket");
    fs.writeFileSync(p, "");
    const r = readSocketIdentity(p);
    expect(r.kind).toBe("present");
    if (r.kind === "present") {
      const st = fs.statSync(p);
      expect(r.identity).toEqual({ dev: st.dev, ino: st.ino });
    }
  });

  test("missing path → absent (ENOENT is the one benign miss)", () => {
    expect(readSocketIdentity(path.join(dir, "nope")).kind).toBe("absent");
  });

  test("non-ENOENT stat error → unreadable (ENOENT is NOT the catch-all)", () => {
    // ENOTDIR is a real non-ENOENT error. Without the discriminator every error
    // collapses to `absent`, masking an unreadable path. [LAW:no-silent-failure]
    const file = path.join(dir, "afile");
    fs.writeFileSync(file, "");
    const r = readSocketIdentity(path.join(file, "under-a-file"));
    expect(r.kind).toBe("unreadable");
    if (r.kind === "unreadable") {
      expect(r.detail.length).toBeGreaterThan(0);
    }
  });

  test("path replaced by a distinct fs entry → checkOwnership sees displaced", () => {
    // Rename over the path guarantees a distinct inode, with no reuse flakiness.
    const p = path.join(dir, "socket");
    fs.writeFileSync(p, "a");
    const bound = readSocketIdentity(p);
    expect(bound.kind).toBe("present");

    const sibling = path.join(dir, "other");
    fs.writeFileSync(sibling, "b");
    fs.renameSync(sibling, p);

    expect(
      bound.kind === "present" &&
        checkOwnership(bound.identity, readSocketIdentity(p), MY_PID, MINE)
          .kind,
    ).toBe("displaced");
  });
});

describe("makeOwnershipWatch (armed self-check → single shutdown funnel)", () => {
  function watchDeps(
    over: Partial<OwnershipWatchDeps> &
      Pick<OwnershipWatchDeps, "readIdentity">,
  ): { deps: OwnershipWatchDeps; shutdownCalls: number[] } {
    const shutdownCalls: number[] = [];
    return {
      shutdownCalls,
      deps: {
        bound: BOUND,
        myPid: MY_PID,
        readLease: () => MINE,
        shutdown: (code) => shutdownCalls.push(code),
        log: () => {},
        intervalMs: 1000,
        ...over,
      },
    };
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  test("untouched identity → no shutdown across many intervals", () => {
    jest.useFakeTimers();
    const { deps, shutdownCalls } = watchDeps({
      readIdentity: () => ({ kind: "present", identity: { ...BOUND } }),
    });
    makeOwnershipWatch(deps).arm();
    jest.advanceTimersByTime(1000 * 20);
    expect(shutdownCalls).toEqual([]);
  });

  test("displacement fires shutdown(0) within one interval, then self-disarms", () => {
    jest.useFakeTimers();
    let current: IdentityRead = { kind: "present", identity: { ...BOUND } };
    let reads = 0;
    const { deps, shutdownCalls } = watchDeps({
      readIdentity: () => {
        reads++;
        return current;
      },
    });
    makeOwnershipWatch(deps).arm();

    jest.advanceTimersByTime(1000);
    expect(shutdownCalls).toEqual([]);
    const readsWhileOwning = reads;

    current = { kind: "present", identity: { dev: 1, ino: 999 } };
    jest.advanceTimersByTime(1000);
    expect(shutdownCalls).toEqual([0]);
    const readsAtDisplacement = reads;

    // Self-disarmed: no zombie statSync and no re-funnel across later intervals.
    jest.advanceTimersByTime(1000 * 5);
    expect(shutdownCalls).toEqual([0]);
    expect(reads).toBe(readsAtDisplacement);
    expect(readsAtDisplacement).toBe(readsWhileOwning + 1);
  });

  test("check() returns the decision and is timer-independent", () => {
    let current: IdentityRead = { kind: "present", identity: { ...BOUND } };
    const { deps, shutdownCalls } = watchDeps({ readIdentity: () => current });
    const w = makeOwnershipWatch(deps);
    expect(w.check()).toEqual({ kind: "owned" });
    expect(shutdownCalls).toEqual([]);
    current = { kind: "absent" };
    expect(w.check().kind).toBe("displaced");
    expect(shutdownCalls).toEqual([0]);
  });

  test("lease reassigned under an armed watch (inode unchanged) → exits within one interval", () => {
    jest.useFakeTimers();
    let lease: LeaseRead = MINE;
    const { deps, shutdownCalls } = watchDeps({
      readIdentity: () => HELD,
      readLease: () => lease,
    });
    makeOwnershipWatch(deps).arm();

    jest.advanceTimersByTime(1000 * 3);
    expect(shutdownCalls).toEqual([]);

    lease = { kind: "owned", pid: 9999, startTime: "thief" };
    jest.advanceTimersByTime(1000);
    expect(shutdownCalls).toEqual([0]);
  });

  test("real fs: swapping the path's inode under an armed watch exits within one interval", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-own-armed-"));
    try {
      const p = path.join(dir, "socket");
      fs.writeFileSync(p, "");
      const boundRead = readSocketIdentity(p);
      expect(boundRead.kind).toBe("present");
      if (boundRead.kind !== "present") return;

      jest.useFakeTimers();
      const { deps, shutdownCalls } = watchDeps({
        bound: boundRead.identity,
        readIdentity: () => readSocketIdentity(p),
      });
      makeOwnershipWatch(deps).arm();

      jest.advanceTimersByTime(1000 * 3);
      expect(shutdownCalls).toEqual([]);

      const sibling = path.join(dir, "other");
      fs.writeFileSync(sibling, "");
      fs.renameSync(sibling, p);

      jest.advanceTimersByTime(1000);
      expect(shutdownCalls).toEqual([0]);
    } finally {
      jest.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
