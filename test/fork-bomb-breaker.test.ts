import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  admitDaemon,
  countLiveEntries,
  daemonCeiling,
  decideBoot,
  listRegistryFiles,
  readRegistryEntry,
  realBreakerDeps,
  releaseRegistration,
  type BreakerDeps,
  type RegistryEntry,
} from "../src/daemon/fork-bomb-breaker";

function freshDir(): string {
  return path.join(os.tmpdir(), `cc-candybar-breaker-${crypto.randomUUID()}`);
}

// ─── decideBoot: full input-space enumeration ────────────────────────────────
//
// [LAW:effects-at-boundaries] decideBoot is a pure fold — every branch is
// exercised here with plain values, no fs, no real processes.

describe("decideBoot (pure decision)", () => {
  test("not isolated → always allow, regardless of count or ceiling", () => {
    expect(decideBoot(false, 0, 1).allow).toBe(true);
    expect(decideBoot(false, 999, 1).allow).toBe(true);
    expect(decideBoot(false, 0, 0).allow).toBe(true);
  });

  test("not isolated → reason cites exemption, not a count", () => {
    const d = decideBoot(false, 5, 2);
    expect(d.reason).toMatch(/exempt/);
  });

  test("isolated, count below ceiling → allow", () => {
    const d = decideBoot(true, 3, 16);
    expect(d.allow).toBe(true);
    expect(d.reason).toContain("3");
    expect(d.reason).toContain("16");
  });

  test("isolated, count one below ceiling (boundary) → allow", () => {
    expect(decideBoot(true, 15, 16).allow).toBe(true);
  });

  test("isolated, count equal to ceiling (boundary) → deny", () => {
    const d = decideBoot(true, 16, 16);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("16");
  });

  test("isolated, count above ceiling → deny", () => {
    expect(decideBoot(true, 200, 16).allow).toBe(false);
  });

  test("isolated, zero ceiling, zero count → deny (no room at all)", () => {
    expect(decideBoot(true, 0, 0).allow).toBe(false);
  });
});

// ─── countLiveEntries: pure fold over injected liveness + sweep ─────────────

describe("countLiveEntries (pure fold)", () => {
  const entry = (pid: number): RegistryEntry => ({
    path: `/fake/pid-${pid}.json`,
    identity: { pid, startTime: "st" },
  });

  test("empty list → 0, no sweep calls", () => {
    const sweep = jest.fn();
    expect(countLiveEntries([], () => true, sweep)).toBe(0);
    expect(sweep).not.toHaveBeenCalled();
  });

  test("all live → counts every entry, never sweeps", () => {
    const sweep = jest.fn();
    const entries = [entry(1), entry(2), entry(3)];
    expect(countLiveEntries(entries, () => true, sweep)).toBe(3);
    expect(sweep).not.toHaveBeenCalled();
  });

  test("all dead → counts 0, sweeps every entry", () => {
    const sweep = jest.fn();
    const entries = [entry(1), entry(2)];
    expect(countLiveEntries(entries, () => false, sweep)).toBe(0);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(sweep).toHaveBeenCalledWith(entries[0]!.path);
    expect(sweep).toHaveBeenCalledWith(entries[1]!.path);
  });

  test("mixed live/dead → counts only live, sweeps only dead", () => {
    const sweep = jest.fn();
    const live = entry(1);
    const dead = entry(2);
    const isSame = (pid: number): boolean => pid === live.identity.pid;
    expect(countLiveEntries([live, dead], isSame, sweep)).toBe(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledWith(dead.path);
  });
});

// ─── daemonCeiling: env var parsing ──────────────────────────────────────────

describe("daemonCeiling", () => {
  const ORIGINAL = process.env["CC_CANDYBAR_DAEMON_CEILING"];
  afterEach(() => {
    if (ORIGINAL === undefined)
      delete process.env["CC_CANDYBAR_DAEMON_CEILING"];
    else process.env["CC_CANDYBAR_DAEMON_CEILING"] = ORIGINAL;
  });

  test("defaults to 16 when unset", () => {
    delete process.env["CC_CANDYBAR_DAEMON_CEILING"];
    expect(daemonCeiling()).toBe(16);
  });

  test("reads a valid positive override", () => {
    process.env["CC_CANDYBAR_DAEMON_CEILING"] = "3";
    expect(daemonCeiling()).toBe(3);
  });

  test("falls back to default on garbage (non-numeric)", () => {
    process.env["CC_CANDYBAR_DAEMON_CEILING"] = "not-a-number";
    expect(daemonCeiling()).toBe(16);
  });

  test("falls back to default on trailing garbage — a typo must not silently truncate (e.g. '160' fat-fingered as '16o')", () => {
    process.env["CC_CANDYBAR_DAEMON_CEILING"] = "16o";
    expect(daemonCeiling()).toBe(16);
    // Not the truncated 16 — DEFAULT_CEILING also happens to be 16, so pin a
    // value where truncation and the default would visibly disagree.
    process.env["CC_CANDYBAR_DAEMON_CEILING"] = "32o";
    expect(daemonCeiling()).toBe(16);
  });

  test("falls back to default on zero or negative (a ceiling of 0 would refuse everything)", () => {
    process.env["CC_CANDYBAR_DAEMON_CEILING"] = "0";
    expect(daemonCeiling()).toBe(16);
    process.env["CC_CANDYBAR_DAEMON_CEILING"] = "-5";
    expect(daemonCeiling()).toBe(16);
  });
});

// ─── readRegistryEntry / listRegistryFiles: real fs boundary ────────────────

describe("readRegistryEntry", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
    fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("reads a valid entry", () => {
    const p = path.join(dir, "pid-123.json");
    fs.writeFileSync(p, JSON.stringify({ pid: 123, startTime: "st" }));
    expect(readRegistryEntry(p)).toEqual({ pid: 123, startTime: "st" });
  });

  test("startTime absent → null (unfingerprinted host)", () => {
    const p = path.join(dir, "pid-123.json");
    fs.writeFileSync(p, JSON.stringify({ pid: 123 }));
    expect(readRegistryEntry(p)).toEqual({ pid: 123, startTime: null });
  });

  test("missing file → null", () => {
    expect(readRegistryEntry(path.join(dir, "nope.json"))).toBeNull();
  });

  test("corrupt JSON → null", () => {
    const p = path.join(dir, "pid-123.json");
    fs.writeFileSync(p, "{not json");
    expect(readRegistryEntry(p)).toBeNull();
  });

  test("non-integer pid → null", () => {
    const p = path.join(dir, "pid-x.json");
    fs.writeFileSync(p, JSON.stringify({ pid: 1.5 }));
    expect(readRegistryEntry(p)).toBeNull();
  });

  test("zero pid → null (would signal our own process group via kill(0,0))", () => {
    const p = path.join(dir, "pid-0.json");
    fs.writeFileSync(p, JSON.stringify({ pid: 0 }));
    expect(readRegistryEntry(p)).toBeNull();
  });

  test("negative pid → null", () => {
    const p = path.join(dir, "pid-neg.json");
    fs.writeFileSync(p, JSON.stringify({ pid: -7 }));
    expect(readRegistryEntry(p)).toBeNull();
  });
});

describe("listRegistryFiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("nonexistent dir → empty list, never throws", () => {
    expect(listRegistryFiles(dir)).toEqual([]);
  });

  test("lists only .json files, full paths", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "pid-1.json"), "{}");
    fs.writeFileSync(path.join(dir, "stray.tmp"), "junk");
    const files = listRegistryFiles(dir);
    expect(files).toEqual([path.join(dir, "pid-1.json")]);
  });
});

// ─── realBreakerDeps.ensureDirSafe: symlinked-parent hijack, default vs
// override ────────────────────────────────────────────────────────────────
//
// [LAW:effects-at-boundaries] `lstatSync` only inspects a path's FINAL
// component; verifying just the leaf registry dir lets a symlinked PARENT be
// silently followed by `mkdirSync({recursive:true})`, after which the
// freshly-created leaf looks perfectly clean despite living inside
// attacker-controlled storage — the same class of attack
// `ensureSocketParentSafe` guards against for the socket path. Mirrors
// test/daemon-socket-safety.test.ts's style: real tmp dirs, a real symlink.

describe("realBreakerDeps ensureDirSafe (registry directory safety)", () => {
  const ORIGINAL = process.env["CC_CANDYBAR_DAEMON_REGISTRY_DIR"];
  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env["CC_CANDYBAR_DAEMON_REGISTRY_DIR"];
    } else {
      process.env["CC_CANDYBAR_DAEMON_REGISTRY_DIR"] = ORIGINAL;
    }
  });

  test("default (unoverridden) registry path refuses a symlinked parent", () => {
    delete process.env["CC_CANDYBAR_DAEMON_REGISTRY_DIR"];
    const real = freshDir();
    fs.mkdirSync(real, { mode: 0o700 });
    const link = freshDir();
    fs.symlinkSync(real, link);
    const registryDir = path.join(link, "daemons");
    try {
      expect(() => realBreakerDeps(null).ensureDirSafe(registryDir)).toThrow(
        /symlink/,
      );
    } finally {
      fs.unlinkSync(link);
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  test("default (unoverridden) registry path accepts a properly-owned parent", () => {
    delete process.env["CC_CANDYBAR_DAEMON_REGISTRY_DIR"];
    const root = freshDir();
    fs.mkdirSync(root, { mode: 0o700 });
    const registryDir = path.join(root, "daemons");
    try {
      expect(() =>
        realBreakerDeps(null).ensureDirSafe(registryDir),
      ).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("overridden registry path checks only the leaf, not its parent (a test tmpdir's parent is not a boundary this breaker owns)", () => {
    const dir = freshDir();
    fs.mkdirSync(dir, { mode: 0o700 });
    process.env["CC_CANDYBAR_DAEMON_REGISTRY_DIR"] = dir;
    try {
      // The parent here is os.tmpdir() itself, which on a shared-/tmp
      // platform would fail the two-level check — proving the override path
      // deliberately does not apply it.
      expect(() => realBreakerDeps(null).ensureDirSafe(dir)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── admitDaemon: effect-layer orchestration over injected deps ────────────

describe("admitDaemon", () => {
  function baseDeps(overrides: Partial<BreakerDeps> = {}): BreakerDeps {
    return {
      isolated: true,
      registryDir: "/fake/registry",
      ceiling: 2,
      pid: 999,
      startTime: "my-start-time",
      isSameLiveProcess: () => true,
      listFiles: () => [],
      readEntry: () => null,
      removeFile: jest.fn(),
      writeEntry: jest.fn(),
      ensureDirSafe: jest.fn(),
      ...overrides,
    };
  }

  test("exempt (not isolated) → allowed, never touches the registry", () => {
    const ensureDirSafe = jest.fn();
    const listFiles = jest.fn(() => []);
    const writeEntry = jest.fn();
    const result = admitDaemon(
      baseDeps({ isolated: false, ensureDirSafe, listFiles, writeEntry }),
    );
    expect(result.decision.allow).toBe(true);
    expect(result.registryPath).toBeNull();
    expect(ensureDirSafe).not.toHaveBeenCalled();
    expect(listFiles).not.toHaveBeenCalled();
    expect(writeEntry).not.toHaveBeenCalled();
  });

  test("isolated, below ceiling → allowed and writes its own entry", () => {
    const writeEntry = jest.fn();
    const result = admitDaemon(
      baseDeps({
        listFiles: () => ["/fake/registry/pid-1.json"],
        readEntry: () => ({ pid: 1, startTime: "st" }),
        isSameLiveProcess: () => true, // the one existing entry is live
        writeEntry,
      }),
    );
    expect(result.decision.allow).toBe(true);
    expect(result.registryPath).toBe(
      path.join("/fake/registry", "pid-999.json"),
    );
    expect(writeEntry).toHaveBeenCalledWith(result.registryPath, {
      pid: 999,
      startTime: "my-start-time",
    });
  });

  test("isolated, at ceiling → refused, does not write an entry", () => {
    const writeEntry = jest.fn();
    const result = admitDaemon(
      baseDeps({
        ceiling: 1,
        listFiles: () => ["/fake/registry/pid-1.json"],
        readEntry: () => ({ pid: 1, startTime: "st" }),
        isSameLiveProcess: () => true,
        writeEntry,
      }),
    );
    expect(result.decision.allow).toBe(false);
    expect(result.registryPath).toBeNull();
    expect(writeEntry).not.toHaveBeenCalled();
  });

  test("isolated, corrupt/unreadable entries excluded (fail-open undercount)", () => {
    const result = admitDaemon(
      baseDeps({
        ceiling: 1,
        listFiles: () => ["/fake/registry/corrupt.json"],
        readEntry: () => null, // unreadable — excluded from the count entirely
        isSameLiveProcess: () => true,
      }),
    );
    // The corrupt entry never enters the live count, so a ceiling of 1 still
    // has room for us.
    expect(result.decision.allow).toBe(true);
  });

  test("isolated, dead sibling entries are swept and don't count against the ceiling", () => {
    const removeFile = jest.fn();
    const result = admitDaemon(
      baseDeps({
        ceiling: 1,
        listFiles: () => ["/fake/registry/pid-1.json"],
        readEntry: () => ({ pid: 1, startTime: "st" }),
        isSameLiveProcess: () => false, // stale — pid 1 is gone
        removeFile,
      }),
    );
    expect(result.decision.allow).toBe(true);
    expect(removeFile).toHaveBeenCalledWith("/fake/registry/pid-1.json");
  });
});

// ─── releaseRegistration: only remove if it still names us ─────────────────

describe("releaseRegistration", () => {
  test("removes the entry when it still names our pid", () => {
    const removeFile = jest.fn();
    releaseRegistration(
      "/fake/pid-42.json",
      42,
      () => ({ pid: 42, startTime: "st" }),
      removeFile,
    );
    expect(removeFile).toHaveBeenCalledWith("/fake/pid-42.json");
  });

  test("does not remove when a different pid now owns the entry", () => {
    const removeFile = jest.fn();
    releaseRegistration(
      "/fake/pid-42.json",
      42,
      () => ({ pid: 999, startTime: "st" }),
      removeFile,
    );
    expect(removeFile).not.toHaveBeenCalled();
  });

  test("does not remove when the entry is unreadable/absent", () => {
    const removeFile = jest.fn();
    releaseRegistration("/fake/pid-42.json", 42, () => null, removeFile);
    expect(removeFile).not.toHaveBeenCalled();
  });
});
