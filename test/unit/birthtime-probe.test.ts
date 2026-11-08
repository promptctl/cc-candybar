import {
  birthtimeLine,
  birthtimeOf,
  CTIME_WAIT_MS,
  probeBirthtime,
  type BirthtimeVerdict,
  type ProbeSteps,
} from "../../src/disk/birthtime-probe";
import type { Monotonic } from "../../src/time";
import { identityKey, sameIdentity } from "../../src/utils/folder-identity";

// A scratch folder on a stubbed host: `tickEvery` is how many metadata writes
// it takes for ctime to move (a coarse clock), and Infinity is one that never
// moves; `copiesCtime` is libuv's fallback, where birth time reads as ctime.
const host = (opts: { copiesCtime: boolean; tickEvery: number }) => {
  let ctimeNs = 1_000n;
  let writes = 0;
  const removed: string[] = [];
  const steps: ProbeSteps = {
    makeFolder: () => "/tmp/probe",
    stat: () => ({ ctimeNs, birthtimeNs: opts.copiesCtime ? ctimeNs : 500n }),
    touch: () => {
      writes += 1;
      if (writes % opts.tickEvery === 0) ctimeNs += 4_000_000n;
    },
    remove: (at) => void removed.push(at),
  };
  return { steps, removed, writes: () => writes };
};

// A monotonic clock that moves 1 ms on every read, so a loop on it ends.
const ticking = () => {
  let ms = 0;
  return { monotonic: () => (ms += 1) as Monotonic };
};

const supplied: BirthtimeVerdict = { kind: "supplied" };
const ctime: BirthtimeVerdict = { kind: "ctime" };

describe("the birth-time probe", () => {
  test("answers ctime where birth time moves with ctime, and removes its folder", () => {
    const h = host({ copiesCtime: true, tickEvery: 1 });
    expect(probeBirthtime(h.steps, ticking())).toEqual(ctime);
    expect(h.removed).toEqual(["/tmp/probe"]);
  });

  test("answers supplied where birth time stays put as ctime moves", () => {
    const h = host({ copiesCtime: false, tickEvery: 1 });
    expect(probeBirthtime(h.steps, ticking())).toEqual(supplied);
  });

  test("still decides when ctime moves only on the third write", () => {
    const fallback = host({ copiesCtime: true, tickEvery: 3 });
    expect(probeBirthtime(fallback.steps, ticking())).toEqual(ctime);
    expect(fallback.writes()).toBe(3);
    const statx = host({ copiesCtime: false, tickEvery: 3 });
    expect(probeBirthtime(statx.steps, ticking())).toEqual(supplied);
  });

  test("gives no verdict when ctime never moves within the bound, copy or not, and says so as a warning", () => {
    const unmoved: BirthtimeVerdict = {
      kind: "unprobed",
      reason: `ctime did not move within ${CTIME_WAIT_MS} ms`,
    };
    for (const copiesCtime of [true, false]) {
      const h = host({ copiesCtime, tickEvery: Infinity });
      expect(probeBirthtime(h.steps, ticking())).toEqual(unmoved);
      expect(h.writes()).toBeLessThanOrEqual(CTIME_WAIT_MS);
      expect(h.removed).toEqual(["/tmp/probe"]);
    }
    expect(birthtimeLine(unmoved)[0]).toBe("warn");
  });

  test("a probe that cannot run says why, and still removes its folder", () => {
    const h = host({ copiesCtime: true, tickEvery: 1 });
    const refused: ProbeSteps = {
      ...h.steps,
      touch: () => {
        throw new Error("EPERM: operation not permitted, chmod '/tmp/probe'");
      },
    };
    expect(probeBirthtime(refused, ticking())).toEqual({
      kind: "unprobed",
      reason: "EPERM: operation not permitted, chmod '/tmp/probe'",
    });
    expect(h.removed).toEqual(["/tmp/probe"]);
    const nowhere: ProbeSteps = {
      ...h.steps,
      makeFolder: () => {
        throw new Error("ENOSPC: no space left on device, mkdtemp");
      },
    };
    expect(probeBirthtime(nowhere, ticking())).toEqual({
      kind: "unprobed",
      reason: "ENOSPC: no space left on device, mkdtemp",
    });
  });
});

describe("a folder's identity from the birth time the probe allows", () => {
  const identity = (verdict: BirthtimeVerdict, ino: bigint, birthtimeNs: bigint) => ({
    dev: 7n,
    ino,
    birthtimeNs: birthtimeOf(verdict, birthtimeNs),
  });
  const key = (verdict: BirthtimeVerdict, ino: bigint, birthtimeNs: bigint) =>
    identityKey(identity(verdict, ino, birthtimeNs));

  test("under the fallback, stays put across a child write that moved ctime", () => {
    expect(key(ctime, 42n, 1_000n)).toBe(key(ctime, 42n, 9_000n));
    expect(sameIdentity(identity(ctime, 42n, 1_000n), identity(ctime, 42n, 9_000n))).toBe(true);
  });

  test("with a real birth time, a folder made again on a reused inode is another folder", () => {
    expect(key(supplied, 42n, 1_000n)).not.toBe(key(supplied, 42n, 9_000n));
    expect(sameIdentity(identity(supplied, 42n, 1_000n), identity(supplied, 42n, 9_000n))).toBe(
      false,
    );
  });

  test("statx's 0 is no birth time, as the fallback's copy is", () => {
    expect(birthtimeOf(supplied, 0n)).toBeNull();
    expect(birthtimeOf(ctime, 1_000n)).toBeNull();
    expect(birthtimeOf(supplied, 1_000n)).toBe(1_000n);
  });
});
