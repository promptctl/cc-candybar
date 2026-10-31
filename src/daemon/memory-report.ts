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

import type { LaunchResult, Launcher } from "../proc/launch.js";

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
  readonly read: () => ProbeOutcome;
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
export function memoryReport(probes: readonly MemoryProbe[]): string {
  const refusals: string[] = [];
  for (const probe of probes) {
    const outcome = probe.read();
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
      // answer to `footprint`, and free (no subprocess).
      fileProbe("/proc/self/smaps_rollup"),
      // Always present, coarser: VmRSS and friends, so Linux never falls all
      // the way through to "no probe answered".
      fileProbe("/proc/self/status"),
    ];
  }
  return [];
}

// [FRAMING:representation] What the platform charges a process for its
// memory — the number the budget is on. RSS is that charge on Linux, but not on
// macOS: there resident memory still counts the pages malloc has freed and
// marked reusable, which the kernel reclaims whenever it needs them, while the
// charge is `phys_footprint` (what Activity Monitor and jetsam read). Measured
// on the live daemon 2026-10-21 (brandon-unfiled-3248.2j3m): RSS 335 MB against
// a 218 MB footprint, and two backstop breaches at a 342 and a 386 MB
// footprint, under a 512 MB limit.
export type ChargeMeasure = "phys_footprint" | "rss";

// [LAW:types-are-the-program] `charged` is the platform's own measure;
// `stand-in` is RSS judged in its place, carrying why the platform's measure
// could not be read — so a footprint reading never carries a reason, and an
// RSS reading on Linux never claims a probe failed.
export type MemoryCharge =
  | {
      readonly kind: "charged";
      readonly measure: ChargeMeasure;
      readonly bytes: number;
    }
  | {
      readonly kind: "stand-in";
      readonly bytes: number;
      readonly unread: string;
    };

// Reads the charge, given the RSS read at the same moment (the charge itself
// where the platform charges RSS, and the stand-in where its probe fails).
export type ChargeProbe = (rss: number) => Promise<MemoryCharge>;

// [LAW:dataflow-not-control-flow] The platform is the discriminator, chosen
// once: the backstop asks the probe it was handed, never which platform runs.
export function chargeProbe(
  launcher: Launcher,
  platform: NodeJS.Platform,
  pid: number,
): ChargeProbe {
  return platform === "darwin"
    ? footprintCharge(pid, (args) =>
        launcher.launch({
          bin: FOOTPRINT,
          args,
          timeoutMs: PROBE_TIMEOUT_MS,
          category: "limits.charge",
        }),
      )
    : async (rss) => ({ kind: "charged", measure: "rss", bytes: rss });
}

// `footprint --noCategories -f bytes` prints its auxiliary data as exact byte
// counts; the charge is the `phys_footprint:` line.
export function footprintCharge(
  pid: number,
  run: (args: string[]) => Promise<LaunchResult>,
): ChargeProbe {
  return async (rss) => {
    const result = await run([
      "-p",
      String(pid),
      "--noCategories",
      "-f",
      "bytes",
    ]);
    if (!result.ok) {
      return {
        kind: "stand-in",
        bytes: rss,
        unread: `footprint ${result.reason}${
          result.error !== undefined ? `: ${result.error}` : ""
        }${firstLine(result.stderr)}`,
      };
    }
    const bytes = physFootprintOf(result.stdout);
    return bytes === null
      ? {
          kind: "stand-in",
          bytes: rss,
          unread: "footprint printed no phys_footprint line",
        }
      : { kind: "charged", measure: "phys_footprint", bytes };
  };
}

export function physFootprintOf(text: string): number | null {
  const m = /^\s*phys_footprint:\s+(\d+) B\s*$/m.exec(text);
  return m === null ? null : Number(m[1]);
}

function commandProbe(
  launcher: Launcher,
  bin: string,
  args: readonly string[],
): MemoryProbe {
  return {
    name: `${bin} ${args.join(" ")}`,
    read: () => {
      // [LAW:single-enforcer] Through `launchSync` like every other spawn in
      // this codebase: it is the one place that carries the timeout, the
      // category accounting, and a TOTAL result — a raw execFileSync here would
      // be both an unaccounted child and a throw on the death path.
      const result = launcher.launchSync({
        bin,
        args: [...args],
        timeoutMs: PROBE_TIMEOUT_MS,
        category: "limits.memory-report",
      });
      if (!result.ok) {
        return {
          kind: "unavailable",
          reason: `${result.reason}${
            result.error !== undefined ? `: ${result.error}` : ""
          }${firstLine(result.stderr)}`,
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
    read: () => {
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

function firstLine(stderr: string): string {
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line === undefined ? "" : ` (${line})`;
}
