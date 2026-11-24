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
import { processLauncher } from "./helpers/host";

import {
  chargeProbe,
  footprintCharge,
  memoryReport,
  physFootprintsOf,
  platformProbes,
  type MemoryProbe,
} from "../src/daemon/memory-report";
import type { LaunchResult } from "../src/proc/launcher";

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

// [LAW:verifiable-goals] One test that is genuinely about this machine: on the
// host running the suite, the real probes must attribute the test process's own
// memory. A mocked probe can prove the fold; only this can prove the commands
// exist and answer. Skipped off the two platforms that declare probes, since
// there the correct behaviour is the "no probe" report asserted above.
const REAL = os.platform() === "darwin" || os.platform() === "linux";
(REAL ? test : test.skip)(
  "the real probes attribute this process on this host",
  async () => {
    const report = await memoryReport(
      platformProbes(processLauncher, os.platform(), process.pid),
    );
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
  const ran = (stdout: string): LaunchResult => ({
    ok: true,
    stdout,
    stderr: "",
    exitCode: 0,
  });

  test("footprint's byte output is read off each process's phys_footprint line, never the peak", async () => {
    expect(physFootprintsOf(FOOTPRINT)).toEqual(new Map([[91378, 224953704]]));
    expect(
      physFootprintsOf(
        `${footprintOf(77, 1000)}\n${footprintOf(78, 2000)}\n${"=".repeat(70)}\nSummary Footprint: 3000 B`,
      ),
    ).toEqual(
      new Map([
        [77, 1000],
        [78, 2000],
      ]),
    );
    expect(physFootprintsOf("phys_footprint_peak: 9 B")).toEqual(new Map());
    expect(physFootprintsOf("node [1]:\nphys_footprint: 216 MB")).toEqual(
      new Map(),
    );
  });

  test("each process is charged its own footprint, all from one call", async () => {
    const asked: string[][] = [];
    const probe = footprintCharge(async (args) => {
      asked.push(args);
      // footprint's order is its own, not the order asked.
      return ran(`${footprintOf(78, 2000)}\n${footprintOf(77, 1000)}`);
    });
    const host = { pid: 77, sizes: { rss: 1 } };
    const renderer = { pid: 78, sizes: { rss: 1 } };
    expect(await probe([host, renderer])).toEqual([
      {
        process: host,
        charge: { kind: "charged", measure: "phys_footprint", bytes: 1000 },
      },
      {
        process: renderer,
        charge: { kind: "charged", measure: "phys_footprint", bytes: 2000 },
      },
    ]);
    expect(asked).toEqual([
      ["-p", "77", "-p", "78", "--noCategories", "-f", "bytes"],
    ]);
  });

  test("a process footprint printed nothing for stands in on its own RSS, and no other does", async () => {
    const probe = footprintCharge(async () => ran(footprintOf(77, 1000)));
    expect(
      (
        await probe([
          { pid: 77, sizes: { rss: 4 } },
          { pid: 78, sizes: { rss: 5 } },
        ])
      ).map(({ charge }) => charge),
    ).toEqual([
      { kind: "charged", measure: "phys_footprint", bytes: 1000 },
      {
        kind: "stand-in",
        bytes: 5,
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
    expect(
      (
        await failed([
          { pid: 77, sizes: { rss: 5 } },
          { pid: 78, sizes: { rss: 6 } },
        ])
      ).map(({ charge }) => charge),
    ).toEqual([
      {
        kind: "stand-in",
        bytes: 5,
        unread: "footprint timeout: footprint: hung",
      },
      {
        kind: "stand-in",
        bytes: 6,
        unread: "footprint timeout: footprint: hung",
      },
    ]);
  });

  test("off macOS, each process's RSS is its charge", async () => {
    expect(
      (
        await chargeProbe(
          processLauncher,
          "linux",
        )([
          { pid: 1, sizes: { rss: 42 } },
          { pid: 2, sizes: { rss: 43 } },
        ])
      ).map(({ charge }) => charge),
    ).toEqual([
      { kind: "charged", measure: "rss", bytes: 42 },
      { kind: "charged", measure: "rss", bytes: 43 },
    ]);
  });

  (os.platform() === "darwin" ? test : test.skip)(
    "on this Mac, footprint answers for this process and its parent, each its own",
    async () => {
      const charged = await chargeProbe(
        processLauncher,
        "darwin",
      )([
        { pid: process.pid, sizes: { rss: process.memoryUsage().rss } },
        { pid: process.ppid, sizes: { rss: 1 } },
      ]);
      expect(charged.map(({ process: { pid } }) => pid)).toEqual([
        process.pid,
        process.ppid,
      ]);
      for (const { charge } of charged) {
        expect(charge).toMatchObject({
          kind: "charged",
          measure: "phys_footprint",
        });
        expect(charge.bytes).toBeGreaterThan(0);
      }
      expect(charged[0]!.charge.bytes).not.toBe(charged[1]!.charge.bytes);
    },
  );
});
