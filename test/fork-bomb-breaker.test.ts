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

// [LAW:effects-at-boundaries] decideBoot is a pure fold; no fs, no processes.

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
    // Pin a value where truncation and the default would visibly disagree.
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

// [LAW:effects-at-boundaries] `lstatSync` inspects only a path's FINAL
// component, so a symlinked PARENT would be followed by a recursive mkdir.

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
      expect(() => realBreakerDeps(null).ensureDirSafe(dir)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// [LAW:no-silent-failure] A failed rename must leave no orphaned tmp file:
// listRegistryFiles collects only *.json, so a stray .tmp is never swept.

describe("realBreakerDeps writeEntry (no orphaned tmp file)", () => {
  test("rethrows and cleans up the tmp file when the rename target can't accept it", () => {
    const dir = freshDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "pid-123.json");
    // Renaming onto an existing directory fails without touching tmp's write.
    fs.mkdirSync(filePath);
    const identity = { pid: 123, startTime: "st" };
    const tmp = `${filePath}.${identity.pid}.tmp`;
    try {
      expect(() =>
        realBreakerDeps(null).writeEntry(filePath, identity),
      ).toThrow();
      expect(fs.existsSync(tmp)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
        isSameLiveProcess: () => true,
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
        readEntry: () => null,
        isSameLiveProcess: () => true,
      }),
    );
    expect(result.decision.allow).toBe(true);
  });

  test("isolated, dead sibling entries are swept and don't count against the ceiling", () => {
    const removeFile = jest.fn();
    const result = admitDaemon(
      baseDeps({
        ceiling: 1,
        listFiles: () => ["/fake/registry/pid-1.json"],
        readEntry: () => ({ pid: 1, startTime: "st" }),
        isSameLiveProcess: () => false,
        removeFile,
      }),
    );
    expect(result.decision.allow).toBe(true);
    expect(removeFile).toHaveBeenCalledWith("/fake/registry/pid-1.json");
  });

  test("a pid-recycled ghost naming our OWN pid never counts as a live sibling, even when isSameLiveProcess says alive (the ps-unavailable fallback case)", () => {
    // A recycled pid with a DIFFERENT startTime: without `ps`, bare pidAlive
    // would misclassify this ghost as live and exhaust the ceiling.
    const isSameLiveProcess = jest.fn(() => true);
    const result = admitDaemon(
      baseDeps({
        ceiling: 1,
        pid: 999,
        listFiles: () => ["/fake/registry/pid-999.json"],
        readEntry: () => ({ pid: 999, startTime: "a-past-incarnations-time" }),
        isSameLiveProcess,
      }),
    );
    expect(result.decision.allow).toBe(true);
    expect(isSameLiveProcess).not.toHaveBeenCalled();
  });
});

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
