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

import { processLauncher } from "../src/proc/launch";
import os from "node:os";

import {
  chargeProbe,
  footprintCharge,
  memoryReport,
  physFootprintOf,
  platformProbes,
  type MemoryProbe,
} from "../src/daemon/memory-report";
import type { LaunchResult } from "../src/proc/launch";

const answering = (name: string, text: string): MemoryProbe => ({
  name,
  read: async () => ({ kind: "text", text }),
});

const refusing = (name: string, reason: string): MemoryProbe => ({
  name,
  read: async () => ({ kind: "unavailable", reason }),
});

describe("memoryReport", () => {
  test("the first probe that answers wins, and the report names it", async () => {
    const report = await memoryReport([
      answering("footprint -p 7", "118 MB  app-specific tag 16"),
      answering("vmmap --summary 7", "SHOULD NOT BE ASKED"),
    ]);
    expect(report).toContain("# memory report from: footprint -p 7");
    expect(report).toContain("118 MB  app-specific tag 16");
    expect(report).not.toContain("SHOULD NOT BE ASKED");
  });

  test("a refusal falls through to the next probe", async () => {
    const report = await memoryReport([
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
  test("when no probe answers, every reason is in the report", async () => {
    const report = await memoryReport([
      refusing("footprint -p 7", "spawn-error: ENOENT"),
      refusing("vmmap --summary 7", "non-zero: exit 1 (not permitted)"),
    ]);
    expect(report).toContain("no probe answered");
    expect(report).toContain("footprint -p 7: unavailable — spawn-error: ENOENT");
    expect(report).toContain(
      "vmmap --summary 7: unavailable — non-zero: exit 1 (not permitted)",
    );
  });

  test("a platform with no probes still produces a readable report, not an empty one", async () => {
    const report = await memoryReport([]);
    expect(report.trim().length).toBeGreaterThan(0);
    expect(report).toContain("no probe is known for this platform");
  });
});

describe("platformProbes", () => {
  // The rows are the platform fact — asserted by the command each one would run,
  // because that string is what a human re-runs by hand from the report.
  test("darwin prefers footprint, then vmmap, both naming the pid", async () => {
    expect(platformProbes(processLauncher, "darwin", 4242).map((p) => p.name)).toEqual([
      "/usr/bin/footprint -p 4242",
      "/usr/bin/vmmap --summary 4242",
    ]);
  });

  test("linux reads the rollup first, then status — no subprocess either way", async () => {
    expect(platformProbes(processLauncher, "linux", 4242).map((p) => p.name)).toEqual([
      "/proc/self/smaps_rollup",
      "/proc/self/status",
    ]);
  });

  test("an unknown platform contributes no probes rather than a wrong one", async () => {
    expect(platformProbes(processLauncher, "win32", 4242)).toEqual([]);
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
  async () => {
    const report = await memoryReport(platformProbes(processLauncher, os.platform(), process.pid));
    expect(report).toContain("# memory report from:");
    expect(report).not.toContain("no probe answered");
    // Whatever answered, it must carry a size — the one thing every probe on
    // every platform reports, and the reason the artifact is worth writing.
    expect(report).toMatch(/\d/);
    expect(report.length).toBeGreaterThan(40);
  },
  15000,
);

// brandon-unfiled-3248.2j3m: the charge the memory backstop judges.
describe("the memory charge", () => {
  const FOOTPRINT = [
    "======================================================================",
    "node [91378]: 64-bit    Footprint: 224904552 B (16384 bytes per page)",
    "======================================================================",
    "",
    "Auxiliary data:",
    "    phys_footprint: 224953704 B",
    "    phys_footprint_peak: 432772224 B",
  ].join("\n");
  const ran = (stdout: string): LaunchResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });

  test("footprint's byte output is read off its phys_footprint line, never the peak", async () => {
    expect(physFootprintOf(FOOTPRINT)).toBe(224953704);
    expect(physFootprintOf("phys_footprint_peak: 9 B")).toBeNull();
    expect(physFootprintOf("phys_footprint: 216 MB")).toBeNull();
  });

  test("footprint answering is the charge; asked for exact bytes", async () => {
    const asked: string[][] = [];
    const probe = footprintCharge(77, async (args) => {
      asked.push(args);
      return ran(FOOTPRINT);
    });
    expect(await probe(1)).toEqual({ kind: "charged", measure: "phys_footprint", bytes: 224953704 });
    expect(asked).toEqual([["-p", "77", "--noCategories", "-f", "bytes"]]);
  });

  test("footprint failing or unreadable leaves RSS standing in, saying why", async () => {
    const failed = footprintCharge(77, async () => ({
      ok: false,
      reason: "timeout",
      stdout: "",
      stderr: "footprint: hung\n",
      exitCode: null,
      signal: "SIGTERM",
    }));
    expect(await failed(5)).toEqual({ kind: "stand-in", bytes: 5, unread: "footprint timeout (footprint: hung)" });
    const garbled = footprintCharge(77, async () => ran("nothing here"));
    expect(await garbled(5)).toEqual({
      kind: "stand-in",
      bytes: 5,
      unread: "footprint printed no phys_footprint line",
    });
  });

  test("off macOS, RSS is the charge", async () => {
    expect(await chargeProbe(processLauncher, "linux", 1)(42)).toEqual({ kind: "charged", measure: "rss", bytes: 42 });
  });

  (os.platform() === "darwin" ? test : test.skip)("on this Mac, footprint answers for this process", async () => {
    const charge = await chargeProbe(processLauncher, "darwin", process.pid)(process.memoryUsage().rss);
    expect(charge).toMatchObject({ kind: "charged", measure: "phys_footprint" });
    expect(charge.bytes).toBeGreaterThan(0);
  });
});
