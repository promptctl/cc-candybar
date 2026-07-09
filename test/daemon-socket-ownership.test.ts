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

const BOUND: SocketIdentity = { dev: 1, ino: 100 };

// The full input enumeration of the pure fold: only `present + same identity`
// proves ownership; every other input fails toward exit (`displaced`).
describe("checkOwnership (pure fold)", () => {
  test("present + same identity → owned", () => {
    expect(
      checkOwnership(BOUND, { kind: "present", identity: { dev: 1, ino: 100 } }),
    ).toEqual({ kind: "owned" });
  });

  test("present + different inode → displaced", () => {
    const d = checkOwnership(BOUND, {
      kind: "present",
      identity: { dev: 1, ino: 200 },
    });
    expect(d.kind).toBe("displaced");
    expect(d.kind === "displaced" && d.reason).toContain("ino=200");
  });

  test("present + different dev → displaced (dev+ino, not ino alone)", () => {
    const d = checkOwnership(BOUND, {
      kind: "present",
      identity: { dev: 2, ino: 100 },
    });
    expect(d.kind).toBe("displaced");
  });

  test("absent (ENOENT) → displaced", () => {
    const d = checkOwnership(BOUND, { kind: "absent" });
    expect(d.kind).toBe("displaced");
    expect(d.kind === "displaced" && d.reason).toContain("ENOENT");
  });

  test("unreadable → displaced (cannot prove ownership → err toward exit)", () => {
    const d = checkOwnership(BOUND, { kind: "unreadable", detail: "EIO boom" });
    expect(d.kind).toBe("displaced");
    expect(d.kind === "displaced" && d.reason).toContain("EIO boom");
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
    // A path whose parent component is a regular file makes statSync throw
    // ENOTDIR — a real, deterministic non-ENOENT error. This guards the ENOENT
    // discriminator in the catch: drop it and every error would collapse to
    // `absent`, which checkOwnership treats identically here (both → displaced)
    // but which would misreport WHY, and mask a genuinely unreadable path as a
    // benign miss. [LAW:no-silent-failure]
    const file = path.join(dir, "afile");
    fs.writeFileSync(file, "");
    const r = readSocketIdentity(path.join(file, "under-a-file"));
    expect(r.kind).toBe("unreadable");
    if (r.kind === "unreadable") {
      expect(r.detail.length).toBeGreaterThan(0);
    }
  });

  test("path replaced by a distinct fs entry → checkOwnership sees displaced", () => {
    // A regular file suffices: readSocketIdentity reads (dev, ino), the identity
    // of a filesystem entry regardless of its type. Replacing via a coexisting
    // sibling + rename guarantees a distinct inode (no reuse-of-freed-inode
    // flakiness) — exactly what a reclaimer's unlink + fresh bind does.
    const p = path.join(dir, "socket");
    fs.writeFileSync(p, "a");
    const bound = readSocketIdentity(p);
    expect(bound.kind).toBe("present");

    const sibling = path.join(dir, "other");
    fs.writeFileSync(sibling, "b");
    fs.renameSync(sibling, p);

    expect(
      bound.kind === "present" &&
        checkOwnership(bound.identity, readSocketIdentity(p)).kind,
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

  test("displacement fires shutdown(0) within one interval, exactly once", () => {
    jest.useFakeTimers();
    let current: IdentityRead = { kind: "present", identity: { ...BOUND } };
    const { deps, shutdownCalls } = watchDeps({
      readIdentity: () => current,
    });
    makeOwnershipWatch(deps).arm();

    jest.advanceTimersByTime(1000);
    expect(shutdownCalls).toEqual([]); // still owning

    current = { kind: "present", identity: { dev: 1, ino: 999 } }; // displaced
    jest.advanceTimersByTime(1000); // one interval
    expect(shutdownCalls).toEqual([0]);

    // Persistent displacement must not re-funnel — one exit, one log line.
    jest.advanceTimersByTime(1000 * 5);
    expect(shutdownCalls).toEqual([0]);
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

  // The ticket's worded acceptance, in-process against real fs + real timer:
  // swap the socket path's inode under a running watch → shutdown(0) within one
  // interval; an untouched path never exits.
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

      jest.advanceTimersByTime(1000 * 3); // untouched across many intervals
      expect(shutdownCalls).toEqual([]);

      // Reclaimer displaces us: a coexisting sibling renamed over the path.
      const sibling = path.join(dir, "other");
      fs.writeFileSync(sibling, "");
      fs.renameSync(sibling, p);

      jest.advanceTimersByTime(1000); // within one interval
      expect(shutdownCalls).toEqual([0]);
    } finally {
      jest.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
