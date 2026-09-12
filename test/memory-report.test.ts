// [LAW:behavior-not-structure] The contract of the post-mortem capture
// (brandon-daemon-limits-inw): what the RSS backstop writes beside its heap
// snapshot when the two disagree about where the memory went.
//
// The fold is driven by INJECTED probes here, never by the real `footprint`: the
// claim under test is "the first probe that answers wins, and a total failure is
// still a readable report", which is a claim about the fold, not about macOS.
// `platformProbes` is tested for the rows it selects — the one platform fact —
// and one real darwin probe is run at the end, where the claim genuinely is
// about this machine.

import os from "node:os";

import {
  memoryReport,
  platformProbes,
  type MemoryProbe,
} from "../src/daemon/memory-report";

const answering = (name: string, text: string): MemoryProbe => ({
  name,
  read: () => ({ kind: "text", text }),
});

const refusing = (name: string, reason: string): MemoryProbe => ({
  name,
  read: () => ({ kind: "unavailable", reason }),
});

describe("memoryReport", () => {
  test("the first probe that answers wins, and the report names it", () => {
    const report = memoryReport([
      answering("footprint -p 7", "118 MB  app-specific tag 16"),
      answering("vmmap --summary 7", "SHOULD NOT BE ASKED"),
    ]);
    expect(report).toContain("# memory report from: footprint -p 7");
    expect(report).toContain("118 MB  app-specific tag 16");
    expect(report).not.toContain("SHOULD NOT BE ASKED");
  });

  test("a refusal falls through to the next probe", () => {
    const report = memoryReport([
      refusing("footprint -p 7", "spawn-error: ENOENT"),
      answering("vmmap --summary 7", "TOTAL  172M"),
    ]);
    expect(report).toContain("# memory report from: vmmap --summary 7");
    expect(report).toContain("TOTAL  172M");
  });

  // [LAW:no-silent-failure] The whole point of the artifact: when nothing can be
  // measured, the file says which probes were tried and why each one could not
  // answer. An empty file, or a missing one, is indistinguishable from a capture
  // that silently did nothing — which is the blind spot this replaces.
  test("when no probe answers, every reason is in the report", () => {
    const report = memoryReport([
      refusing("footprint -p 7", "spawn-error: ENOENT"),
      refusing("vmmap --summary 7", "non-zero: exit 1 (not permitted)"),
    ]);
    expect(report).toContain("no probe answered");
    expect(report).toContain("footprint -p 7: unavailable — spawn-error: ENOENT");
    expect(report).toContain(
      "vmmap --summary 7: unavailable — non-zero: exit 1 (not permitted)",
    );
  });

  test("a platform with no probes still produces a readable report, not an empty one", () => {
    const report = memoryReport([]);
    expect(report.trim().length).toBeGreaterThan(0);
    expect(report).toContain("no probe is known for this platform");
  });
});

describe("platformProbes", () => {
  // The rows are the platform fact — asserted by the command each one would run,
  // because that string is what a human re-runs by hand from the report.
  test("darwin prefers footprint, then vmmap, both naming the pid", () => {
    expect(platformProbes("darwin", 4242).map((p) => p.name)).toEqual([
      "footprint -p 4242",
      "vmmap --summary 4242",
    ]);
  });

  test("linux reads the rollup first, then status — no subprocess either way", () => {
    expect(platformProbes("linux", 4242).map((p) => p.name)).toEqual([
      "/proc/self/smaps_rollup",
      "/proc/self/status",
    ]);
  });

  test("an unknown platform contributes no probes rather than a wrong one", () => {
    expect(platformProbes("win32", 4242)).toEqual([]);
  });
});

// [LAW:verifiable-goals] One test that is genuinely about this machine: on the
// host running the suite, the real probes must attribute the test process's own
// memory. A mocked probe can prove the fold; only this can prove the commands
// exist and answer. Skipped off the two platforms that declare probes, since
// there the correct behaviour is the "no probe" report asserted above.
const REAL = os.platform() === "darwin" || os.platform() === "linux";
(REAL ? test : test.skip)(
  "the real probes attribute this process on this host",
  () => {
    const report = memoryReport(platformProbes(os.platform(), process.pid));
    expect(report).toContain("# memory report from:");
    expect(report).not.toContain("no probe answered");
    // Whatever answered, it must carry a size — the one thing every probe on
    // every platform reports, and the reason the artifact is worth writing.
    expect(report).toMatch(/\d/);
    expect(report.length).toBeGreaterThan(40);
  },
  15000,
);
