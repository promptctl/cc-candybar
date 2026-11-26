// [LAW:behavior-not-structure] The contract of the post-mortem capture
// (brandon-daemon-limits-inw): what the RSS backstop writes beside its heap
// snapshot when the two disagree about where the memory went.
//
// The fold is driven by INJECTED probes here, never by the real `footprint`: the
// claim under test is "the first probe that answers wins, and a total failure is
// still a readable report", which is a claim about the fold, not about macOS.
// `platformProbes` is tested for the rows it selects — the one platform fact —
// and footprint's parse for its recorded output, so every case runs the same
// on every machine.

import { processLauncher } from "./helpers/host";

import {
  chargeProbe,
  footprintCharge,
  memoryReport,
  physFootprintsOf,
  platformProbes,
  type ChargeProbe,
  type MemoryProbe,
  type ReadProcess,
} from "../src/daemon/memory-report";
import type { LaunchResult } from "../src/proc/launcher";
import type { OwnUsage } from "../src/daemon/foundations/memory-limit";

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
    expect(report).toContain(
      "footprint -p 7: unavailable — spawn-error: ENOENT",
    );
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
    expect(
      platformProbes(processLauncher, "darwin", 4242).map((p) => p.name),
    ).toEqual(["/usr/bin/footprint -p 4242", "/usr/bin/vmmap --summary 4242"]);
  });

  test("linux reads the pid's rollup first, then its status — no subprocess either way", async () => {
    expect(
      platformProbes(processLauncher, "linux", 4242).map((p) => p.name),
    ).toEqual(["/proc/4242/smaps_rollup", "/proc/4242/status"]);
  });

  test("an unknown platform contributes no probes rather than a wrong one", async () => {
    expect(platformProbes(processLauncher, "win32", 4242)).toEqual([]);
  });
});

// brandon-unfiled-3248.2j3m: the charge the memory backstop judges.
describe("the memory charge", () => {
  // footprint's block for one process, as it prints it.
  const footprintOf = (pid: number, bytes: number): string =>
    [
      "======================================================================",
      `node [${pid}]: 64-bit    Footprint: ${bytes - 48152} B (16384 bytes per page)`,
      "======================================================================",
      "",
      "Auxiliary data:",
      `    phys_footprint: ${bytes} B`,
      "    phys_footprint_peak: 432772224 B",
    ].join("\n");
  const FOOTPRINT = footprintOf(91378, 224953704);
  // What a process last said of itself, its RSS the one figure a charge
  // reads of it.
  const rssOf = (rss: number): OwnUsage => ({
    kind: "read",
    sizes: { rss, heapTotal: 0 },
  });
  // Each process's charge, as one reading of them all answers it.
  const chargesOf = async (
    probe: ChargeProbe,
    processes: readonly ReadProcess[],
  ) => processes.map(await probe(processes));
  const ran = (stdout: string): LaunchResult => ({
    ok: true,
    stdout,
    stderr: "",
    exitCode: 0,
  });

  test("footprint's byte output is read off each process's phys_footprint line, never the peak", async () => {
    const byPid = (text: string) => physFootprintsOf(text).byPid;
    expect(byPid(FOOTPRINT)).toEqual(new Map([[91378, 224953704]]));
    expect(
      byPid(
        `${footprintOf(77, 1000)}\n${footprintOf(78, 2000)}\n${"=".repeat(70)}\nSummary Footprint: 3000 B`,
      ),
    ).toEqual(
      new Map([
        [77, 1000],
        [78, 2000],
      ]),
    );
    expect(byPid("phys_footprint_peak: 9 B")).toEqual(new Map());
    expect(byPid(footprintOf(1, 1000).replace("1000 B", "216 MB"))).toEqual(
      new Map(),
    );
  });

  test("a section whose header names no pid credits its footprint to no process, and says so", async () => {
    const unnamed = footprintOf(78, 2000).replace("node [78]:", "node:");
    const header = unnamed.split("\n")[1]!;
    const printed = physFootprintsOf(`${footprintOf(77, 1000)}\n${unnamed}`);
    expect(printed).toEqual({
      byPid: new Map([[77, 1000]]),
      unnamed: [header],
    });
    const probe = footprintCharge(async () =>
      ran(`${footprintOf(77, 1000)}\n${unnamed}`),
    );
    await expect(
      chargesOf(probe, [
        { pid: 77, usage: rssOf(4) },
        { pid: 78, usage: rssOf(5) },
      ]),
    ).resolves.toEqual([
      { kind: "charged", measure: "phys_footprint", bytes: 1000 },
      {
        kind: "stand-in",
        rss: 5,
        unread: `footprint printed no phys_footprint for pid 78; its section ${JSON.stringify(header)} names no pid`,
      },
    ]);
  });

  test("a process that has said no RSS of itself, and that footprint missed, is unread, saying both", async () => {
    const probe = footprintCharge(async () => ran(footprintOf(77, 1000)));
    await expect(
      chargesOf(probe, [
        {
          pid: 78,
          usage: { kind: "unread", why: "no ping has answered yet" },
        },
      ]),
    ).resolves.toEqual([
      {
        kind: "unread",
        unread:
          "footprint printed no phys_footprint for pid 78, and no ping has answered yet",
      },
    ]);
  });

  test("each process is charged its own footprint, all from one call", async () => {
    const asked: string[][] = [];
    const probe = footprintCharge(async (args) => {
      asked.push(args);
      // footprint's order is its own, not the order asked.
      return ran(`${footprintOf(78, 2000)}\n${footprintOf(77, 1000)}`);
    });
    const host = { pid: 77, usage: rssOf(1) };
    const renderer = { pid: 78, usage: rssOf(1) };
    // Asked in the other order, each is still its own.
    await expect(chargesOf(probe, [renderer, host])).resolves.toEqual([
      { kind: "charged", measure: "phys_footprint", bytes: 2000 },
      { kind: "charged", measure: "phys_footprint", bytes: 1000 },
    ]);
    expect(asked).toEqual([
      ["-p", "78", "-p", "77", "--noCategories", "-f", "bytes"],
    ]);
  });

  test("a process footprint printed nothing for stands in on its own RSS, and no other does", async () => {
    const probe = footprintCharge(async () => ran(footprintOf(77, 1000)));
    await expect(
      chargesOf(probe, [
        { pid: 77, usage: rssOf(4) },
        { pid: 78, usage: rssOf(5) },
      ]),
    ).resolves.toEqual([
      { kind: "charged", measure: "phys_footprint", bytes: 1000 },
      {
        kind: "stand-in",
        rss: 5,
        unread: "footprint printed no phys_footprint for pid 78",
      },
    ]);
  });

  test("footprint failing leaves every process's RSS standing in, saying why", async () => {
    const failed = footprintCharge(async () => ({
      ok: false,
      reason: "timeout",
      stdout: "",
      stderr: "footprint: hung\n",
      exitCode: null,
      signal: "SIGTERM",
    }));
    await expect(
      chargesOf(failed, [
        { pid: 77, usage: rssOf(5) },
        { pid: 78, usage: rssOf(6) },
      ]),
    ).resolves.toEqual([
      {
        kind: "stand-in",
        rss: 5,
        unread: "footprint timeout: footprint: hung",
      },
      {
        kind: "stand-in",
        rss: 6,
        unread: "footprint timeout: footprint: hung",
      },
    ]);
  });

  test("off macOS, each process's RSS is its charge", async () => {
    await expect(
      chargesOf(chargeProbe(processLauncher, "linux"), [
        { pid: 1, usage: rssOf(42) },
        { pid: 2, usage: rssOf(43) },
      ]),
    ).resolves.toEqual([
      { kind: "charged", measure: "rss", bytes: 42 },
      { kind: "charged", measure: "rss", bytes: 43 },
    ]);
    await expect(
      chargesOf(chargeProbe(processLauncher, "linux"), [
        { pid: 1, usage: { kind: "unread", why: "no ping has answered yet" } },
      ]),
    ).resolves.toEqual([
      { kind: "unread", unread: "no ping has answered yet" },
    ]);
  });

  // footprint as macOS 26.5 printed two processes, recorded once
  // (`footprint -p 19274 -p 74707 --noCategories -f bytes`), so the parse is
  // held to the tool's own output on every machine, not to a model of it.
  const RECORDED = [
    "======================================================================",
    "claude [19274]: 64-bit    Footprint: 335087008 B (16384 bytes per page)",
    "======================================================================",
    "",
    "Auxiliary data:",
    "    phys_footprint: 335119776 B",
    "    phys_footprint_peak: 343049632 B",
    "",
    "======================================================================",
    "tmux [74707]: 64-bit    Footprint: 19628272 B (16384 bytes per page)",
    "======================================================================",
    "",
    "Auxiliary data:",
    "    phys_footprint: 19628272 B",
    "    phys_footprint_peak: 26083568 B",
    "",
    "======================================================================",
    "Summary Footprint: 354715280 B",
    "======================================================================",
    "",
  ].join("\n");

  test("footprint's own output, as macOS prints it, charges each process its own phys_footprint", async () => {
    const probe = footprintCharge(async () => ran(RECORDED));
    await expect(
      chargesOf(probe, [
        { pid: 74707, usage: rssOf(1) },
        { pid: 19274, usage: rssOf(1) },
      ]),
    ).resolves.toEqual([
      { kind: "charged", measure: "phys_footprint", bytes: 19628272 },
      { kind: "charged", measure: "phys_footprint", bytes: 335119776 },
    ]);
  });
});
