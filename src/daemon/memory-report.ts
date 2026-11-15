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
import type { MemoryCharge } from "./foundations/memory-limit";

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

// Each process's report, in the order its probes are given: the host's, then
// its renderer's. [LAW:no-ambient-temporal-coupling] Taken together, so both
// describe one moment of a breach that is still growing.
export async function memoryReports(
  each: ReadonlyArray<readonly MemoryProbe[]>,
): Promise<string> {
  return (await Promise.all(each.map(memoryReport))).join("\n\n");
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

// Reads the charge of the processes together, given their RSS read at the
// same moment (the charge itself where the platform charges RSS, and the
// stand-in where its probe fails).
export type ChargeProbe = (
  pids: readonly number[],
  rss: number,
) => Promise<MemoryCharge>;

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
    : async (_pids, rss) => ({ kind: "charged", measure: "rss", bytes: rss });
}

// `footprint --noCategories -f bytes` prints each process's auxiliary data as
// exact byte counts; the charge is the sum of their `phys_footprint:` lines,
// one call for every process, so the processes are read at one moment.
export function footprintCharge(
  run: (args: string[]) => Promise<LaunchResult>,
): ChargeProbe {
  return async (pids, rss) => {
    const result = await run([
      ...pids.flatMap((pid) => ["-p", String(pid)]),
      "--noCategories",
      "-f",
      "bytes",
    ]);
    if (!result.ok) {
      return {
        kind: "stand-in",
        bytes: rss,
        unread: `footprint ${failureText(result)}`,
      };
    }
    const each = physFootprintsOf(result.stdout);
    // [LAW:no-silent-failure] A process footprint left out (one that ended
    // between the read and the call) is no charge of the whole.
    return each.length !== pids.length
      ? {
          kind: "stand-in",
          bytes: rss,
          unread: `footprint printed ${each.length} phys_footprint lines for ${pids.length} processes`,
        }
      : {
          kind: "charged",
          measure: "phys_footprint",
          bytes: each.reduce((total, bytes) => total + bytes, 0),
        };
  };
}

export function physFootprintsOf(text: string): number[] {
  return [...text.matchAll(/^\s*phys_footprint:\s+(\d+) B\s*$/gm)].map((m) =>
    Number(m[1]),
  );
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
