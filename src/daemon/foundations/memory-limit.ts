// The vocabulary of the daemon's memory limit: the units it is said in, a
// breach's post-mortem, what a reading charges and how near the limit it is.
// Shared, so everything the daemon says of its memory says it in one set of words.

import type { RendererName } from "./renderer-name";

export const BYTES_PER_MB = 1024 * 1024;

// [LAW:one-source-of-truth] Bytes in the unit the budget is set in, as every
// sentence about the daemon's memory says them.
export const mb = (bytes: number): number => Math.round(bytes / BYTES_PER_MB);

// [LAW:types-are-the-program] One breach's post-mortem: its identity (the
// stamp, the renderer's name when a renderer breached, and the pid) and each
// artifact it left, by kind. Keyed rather than listed
// because the two are written in separate attempts and either may be missing,
// so a reader asks for the memory report by name instead of searching paths.
// [LAW:one-source-of-truth] THE order of post-mortem identities, by code
// unit as the ISO stamp is written (a collation may weigh its `-` and `:`
// otherwise): the listing sorts by it.
export function laterIdentity(a: string, b: string): boolean {
  return a > b;
}

export interface PostMortem {
  readonly identity: string;
  // The process whose breach it records.
  readonly process: BreachedProcess;
  readonly artifacts: Readonly<Partial<Record<BreachArtifact, string>>>;
}

// [LAW:types-are-the-program] Every process is judged against the limit on
// its own, so a breach is one process's: the host's, which ends the daemon,
// or a renderer's, which ends that renderer alone.
export type BreachedProcess =
  | { readonly kind: "host" }
  | { readonly kind: "renderer"; readonly name: RendererName };

// One process as the stats reply reports it: which it is, and how much of the
// limit it holds. Its post-mortems are files in the state directory, no part
// of what only the running daemon can say of itself.
export interface ProcessMemory {
  readonly pid: number;
  readonly memory: MemoryReading;
  readonly limit: number;
}

// [LAW:single-enforcer] THE judgment of "near the limit": a charge is said to
// be near it as it is read, and the render cache's share is sized under it.
export const NEAR_LIMIT = 0.75;

export function approachingLimit(bytes: number, limit: number): boolean {
  return bytes > limit * NEAR_LIMIT;
}

// [LAW:one-source-of-truth] The one spelling of a charge in a sentence: the
// breach line, the end it gives a renderer and daemon-stats say it this way.
export function chargeWords(charge: ReadCharge): string {
  switch (charge.kind) {
    case "charged":
      return `${charge.measure} ${mb(charge.bytes)} MB`;
    case "stand-in":
      return `rss ${mb(charge.bytes + charge.gap)} MB${charge.gap === 0 ? "" : ` less its last ${mb(charge.gap)} MB gap`} (standing in: ${charge.unread})`;
    case "unread":
      return `unread (${charge.unread})`;
  }
}

// [LAW:one-source-of-truth] The one spelling of a breach: the end it gives a
// process, which the breach line says too.
export function breachWords(charge: JudgedCharge, limit: number): string {
  return `passed its memory limit: ${chargeWords(charge)} > limit ${mb(limit)} MB`;
}

// [LAW:one-source-of-truth] The one spelling of what a process said of its
// own memory, beside its charge in the breach line and daemon-stats.
export function usageWords(usage: OwnUsage): string {
  return usage.kind === "read"
    ? `rss ${mb(usage.sizes.rss)} MB, v8 heap ${mb(usage.sizes.heapTotal)} MB`
    : `no sizes: ${usage.why}`;
}

// [LAW:one-source-of-truth] The one token naming what a charge measured: the
// per-check log line says it this way.
export function measureOf(charge: MemoryCharge): string {
  switch (charge.kind) {
    case "charged":
      return charge.measure;
    case "stand-in":
      return "rss-stand-in";
    case "unread":
      return "unread";
  }
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
// RSS reading on Linux never claims a probe failed. `unread` is neither: no
// measure answered and the process has said no RSS of its own (a renderer
// before its first ping), so nothing judges it and the reading says why.
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
    }
  | { readonly kind: "unread"; readonly unread: string };

// [LAW:one-source-of-truth] The artifacts a breach leaves, spelled ONCE. The
// writer names them from this table, the real lister filters by it, and rotation
// strips it to recover the identity a breach's files share. Three
// independent spellings of one pair — which is what adding the memory report
// naively produced — is exactly how a rotation quietly stops matching what the
// writer emits, leaving a directory that grows forever or a heap snapshot whose
// attribution was evicted from under it.
// Which process breached is the identity's to say, so its heap is a heap
// snapshot like any other's. A host breach under an earlier build also wrote
// its renderer's heap under its own identity, and nothing writes one now; it
// is listed so that rotation still evicts it with its breach.
export const BREACH_ARTIFACTS = {
  memoryReport: { prefix: "memory-", suffix: ".txt" },
  heapSnapshot: { prefix: "heap-", suffix: ".heapsnapshot" },
  rendererHeapSnapshot: { prefix: "renderer-heap-", suffix: ".heapsnapshot" },
} as const;

export type BreachArtifact = keyof typeof BREACH_ARTIFACTS;

// [LAW:types-are-the-program] The backstop's latest reading of one process,
// or none yet: `unmeasured` until a probe answers for it — the instant before
// a daemon's first check, a renderer started since the last one, and for good
// in the browser page, which never arms its limits. Never a construction-time
// number passed off as a reading. Its charge is the platform's, read for
// every process at once; its usage is what the process last said of itself.
export type MemoryReading =
  | { readonly kind: "unmeasured" }
  | {
      readonly kind: "measured";
      readonly charge: ReadCharge;
      readonly usage: OwnUsage;
    };

// [LAW:types-are-the-program] What a process last said of its own memory:
// the host, at the reading itself; a renderer, at its latest ping, every few
// seconds and none before its first. So a renderer's RSS is as old as that
// ping, wherever it stands in for a charge or measures a gap.
export type OwnUsage =
  | { readonly kind: "read"; readonly sizes: MemorySizes }
  | { readonly kind: "unread"; readonly why: string };

// What `process.memoryUsage()` reports, beside every charge: RSS (the charge
// itself on Linux, the stand-in on macOS) and heapTotal, the part V8 admits to
// — the gap between the charge and the heap is the whole reason a breach
// writes an attribution artifact rather than only a heap snapshot.
export interface MemorySizes {
  readonly rss: number;
  readonly heapTotal: number;
}

// [LAW:types-are-the-program] The charge as a reading holds it: the
// platform's own, or RSS standing in less `gap` — how far RSS ran over the
// platform's charge at the last reading it charged, carried through every
// stand-in and unread reading since, 0 before any (and on Linux, whose charge
// IS RSS). `bytes` is what the limit judges, and an unread charge has none.
export type ReadCharge =
  | JudgedCharge
  | {
      readonly kind: "unread";
      readonly gap: number;
      readonly unread: string;
    };

// A charge the limit can judge: one with bytes.
export type JudgedCharge =
  | Extract<MemoryCharge, { kind: "charged" }>
  | {
      readonly kind: "stand-in";
      readonly bytes: number;
      readonly gap: number;
      readonly unread: string;
    };
