// Attribute this process's resident memory as TEXT, for the artifact the RSS
// backstop leaves behind (brandon-daemon-limits-inw).
//
// Why text, and why a subprocess at all: the numbers Node can see are already
// published by stats.ts, and they are precisely the ones that cannot explain the
// case that trips the backstop. Measured on the maintainer's live daemon — 230 MB
// RSS against a 122 MB V8 heap and 6 MB external — the missing ~100 MB was V8's
// own mappings, the malloc side (of which macOS already called 24 MB
// reclaimable), 20 MB of kernel page tables, and 43 MB of clean file-backed
// code. No Node API reports that split, and jemalloc's stats were measured and
// rejected for it: quadrupling the JS heap moved the allocator's resident total
// by 3 MB, because V8's heap never goes through malloc at all. The platform's own
// accounting tools DO report it, so the capture is their output, verbatim
// (design-docs/peer-exploration/3-mechanisms/jemalloc-rss-accounting.md).

import fs from "node:fs";

import {
  failureText,
  type LaunchResult,
  type Launcher,
} from "../proc/launcher.js";
import type { MemoryCharge, OwnUsage } from "./foundations/memory-limit";

// [LAW:parse-dont-validate] A probe either produced text or could not, and the
// reason travels with the failure — it is what the post-mortem reads when no
// probe answered, so it can never be dropped on the floor.
export type ProbeOutcome =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface MemoryProbe {
  // How the report names what answered (or what did not) — a command line or a
  // path, so a reader can re-run it by hand.
  readonly name: string;
  readonly read: () => Promise<ProbeOutcome>;
}

// The capture runs on a path where the daemon is already dying, so it gets a
// bounded wait rather than the operator's patience.
const PROBE_TIMEOUT_MS = 5000;

// [LAW:no-silent-failure] Total by construction: the first probe that answers,
// else a report naming every probe that did not and why. It never throws — its
// caller is mid-shutdown and has nowhere to put an exception — and it never
// returns an empty string, because an empty post-mortem file is
// indistinguishable from a probe that silently did nothing, which is the exact
// blind spot this artifact exists to remove.
export async function memoryReport(
  probes: readonly MemoryProbe[],
): Promise<string> {
  const refusals: string[] = [];
  for (const probe of probes) {
    const outcome = await probe.read();
    if (outcome.kind === "text") {
      return `# memory report from: ${probe.name}\n${outcome.text}`;
    }
    refusals.push(`# ${probe.name}: unavailable — ${outcome.reason}`);
  }
  return [
    "# memory report: no probe answered",
    ...(refusals.length > 0
      ? refusals
      : ["# no probe is known for this platform"]),
  ].join("\n");
}

// [LAW:dataflow-not-control-flow] The platform difference is a LIST in
// preference order, not a branch inside the reader: `memoryReport` folds whatever
// it is handed, so a better probe — or a platform this does not know yet — is a
// row here and nothing else anywhere.
// macOS's own tools by their paths: the detached daemon's PATH is whichever
// shell spawned it, and a stranger first on it would answer in their place.
const FOOTPRINT = "/usr/bin/footprint";
const VMMAP = "/usr/bin/vmmap";

export function platformProbes(
  launcher: Launcher,
  platform: NodeJS.Platform,
  pid: number,
): readonly MemoryProbe[] {
  if (platform === "darwin") {
    return [
      // The whole-process category table: V8's mappings, the MALLOC_* regions
      // with their reclaimable share, and page tables, each with a size.
      commandProbe(launcher, FOOTPRINT, ["-p", String(pid)]),
      // Same mappings, coarser, but present on hosts where `footprint` is not.
      commandProbe(launcher, VMMAP, ["--summary", String(pid)]),
    ];
  }
  if (platform === "linux") {
    return [
      // One line per accounting class for the whole address space — Linux's
      // answer to `footprint`, and free (no subprocess). A process may read
      // its own child's.
      fileProbe(`/proc/${pid}/smaps_rollup`),
      // Always present, coarser: VmRSS and friends, so Linux never falls all
      // the way through to "no probe answered".
      fileProbe(`/proc/${pid}/status`),
    ];
  }
  return [];
}

// A process as a reading finds it: its pid, and what it last said of its own
// memory, whose RSS is the charge itself where the platform charges RSS, and
// the stand-in where its probe fails.
export interface ReadProcess {
  readonly pid: number;
  readonly usage: OwnUsage;
}

// Reads each process's charge, handing each process back beside its own, in
// the order given.
// [LAW:no-ambient-temporal-coupling] On macOS, footprint's measure of all of
// them at one moment, by one call. A charge read off an RSS (Linux's, or a
// stand-in) is as old as its process's own last read of itself (OwnUsage): a
// renderer's is its latest ping's.
export type ChargeProbe = <P extends ReadProcess>(
  processes: readonly P[],
) => Promise<ReadonlyArray<Charged<P>>>;

export interface Charged<P> {
  readonly process: P;
  readonly charge: MemoryCharge;
}

// [LAW:dataflow-not-control-flow] The platform is the discriminator, chosen
// once: the backstop asks the probe it was handed, never which platform runs.
export function chargeProbe(
  launcher: Launcher,
  platform: NodeJS.Platform,
): ChargeProbe {
  return platform === "darwin"
    ? footprintCharge((args) =>
        launcher.launch({
          bin: FOOTPRINT,
          args,
          timeoutMs: PROBE_TIMEOUT_MS,
          category: "limits.charge",
        }),
      )
    : async (processes) =>
        processes.map((process) => ({
          process,
          charge:
            process.usage.kind === "read"
              ? {
                  kind: "charged",
                  measure: "rss",
                  bytes: process.usage.sizes.rss,
                }
              : { kind: "unread", unread: process.usage.why },
        }));
}

// `footprint --noCategories -f bytes` prints each process's auxiliary data as
// exact byte counts under a `name [pid]:` header, in one call for every
// process.
export function footprintCharge(
  run: (args: string[]) => Promise<LaunchResult>,
): ChargeProbe {
  return async (processes) => {
    const result = await run([
      ...processes.flatMap(({ pid }) => ["-p", String(pid)]),
      "--noCategories",
      "-f",
      "bytes",
    ]);
    const printed: Footprints = result.ok
      ? physFootprintsOf(result.stdout)
      : { byPid: new Map<number, number>(), unnamed: [] };
    const unnamed = printed.unnamed.map(
      (header) => `; its section ${JSON.stringify(header)} names no pid`,
    );
    // [LAW:no-silent-failure] A process the call printed no footprint for
    // (one that ended between the read and the call), or every process when
    // the call failed, stands in on its own RSS, saying why.
    return processes.map((process) => {
      const bytes = printed.byPid.get(process.pid);
      const unread = result.ok
        ? `footprint printed no phys_footprint for pid ${process.pid}${unnamed.join("")}`
        : `footprint ${failureText(result)}`;
      const charge: MemoryCharge =
        bytes !== undefined
          ? { kind: "charged", measure: "phys_footprint", bytes }
          : process.usage.kind === "read"
            ? { kind: "stand-in", bytes: process.usage.sizes.rss, unread }
            : { kind: "unread", unread: `${unread}, and ${process.usage.why}` };
      return { process, charge };
    });
  };
}

// What footprint printed: each process's footprint by the pid its section's
// header names, and the header of each section that printed a footprint under
// a header naming no pid.
export interface Footprints {
  readonly byPid: ReadonlyMap<number, number>;
  readonly unnamed: readonly string[];
}

// Each process's `phys_footprint:` (`phys_footprint_peak:` is another line),
// read in its own section: a header between two rules of `=`, then the
// section's lines. [LAW:no-silent-failure] A section whose header names no
// pid is credited to no process, and said.
export function physFootprintsOf(text: string): Footprints {
  const byPid = new Map<number, number>();
  const unnamed: string[] = [];
  let header: string | null = null;
  let pid: number | null = null;
  let opened = false;
  for (const line of text.split("\n")) {
    if (/^=+$/.test(line)) {
      // The rule above a header opens a section; the rule below it closes
      // the header.
      if (!opened) [header, pid] = [null, null];
      opened = !opened;
      continue;
    }
    if (opened) {
      const named = /^\S.*\[(\d+)\]:/.exec(line);
      [header, pid] = [line, named === null ? null : Number(named[1])];
      continue;
    }
    const footprint = /^\s*phys_footprint:\s+(\d+) B\s*$/.exec(line);
    if (footprint === null) continue;
    if (pid !== null) byPid.set(pid, Number(footprint[1]));
    else unnamed.push(header ?? "");
  }
  return { byPid, unnamed };
}

function commandProbe(
  launcher: Launcher,
  bin: string,
  args: readonly string[],
): MemoryProbe {
  return {
    name: `${bin} ${args.join(" ")}`,
    read: async () => {
      // [LAW:single-enforcer] Through `launch` like every other spawn in this
      // codebase: it is the one place that carries the timeout, the category
      // accounting, and a TOTAL result — a raw child_process call here would be
      // both an unaccounted child and a throw on the death path.
      const result = await launcher.launch({
        bin,
        args: [...args],
        timeoutMs: PROBE_TIMEOUT_MS,
        category: "limits.memory-report",
      });
      if (!result.ok) {
        return {
          kind: "unavailable",
          reason: failureText(result),
        };
      }
      // A clean exit that printed nothing is not an answer: writing it would
      // produce the empty artifact this module refuses to leave behind.
      return result.stdout.trim().length > 0
        ? { kind: "text", text: result.stdout }
        : { kind: "unavailable", reason: "exited 0 but printed nothing" };
    },
  };
}

function fileProbe(path: string): MemoryProbe {
  return {
    name: path,
    read: async () => {
      try {
        const text = fs.readFileSync(path, "utf8");
        return text.trim().length > 0
          ? { kind: "text", text }
          : { kind: "unavailable", reason: "empty file" };
      } catch (e) {
        return { kind: "unavailable", reason: (e as Error).message };
      }
    },
  };
}
