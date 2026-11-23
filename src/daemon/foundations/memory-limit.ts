// The vocabulary of the daemon's memory limit: the units it is said in, a
// breach's post-mortem, what a reading charges and how near the limit it is.
// Shared, so everything the daemon says of its memory says it in one set of words.

export const BYTES_PER_MB = 1024 * 1024;

// [LAW:one-source-of-truth] Bytes in the unit the budget is set in, as every
// sentence about the daemon's memory says them.
export const mb = (bytes: number): number => Math.round(bytes / BYTES_PER_MB);

// [LAW:types-are-the-program] One breach's post-mortem: its `<stamp>-<pid>`
// identity and each artifact it left, by kind. Keyed rather than listed
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
  readonly artifacts: Readonly<Partial<Record<BreachArtifact, string>>>;
}

// The daemon as its stats reply reports it: which process it is and how much
// of its budget it holds. Its post-mortems are files, which
// `listPostMortems` (src/daemon/limits.ts) lists and only tests call today, so
// they are no part of what only the running daemon can say of itself.
export interface ServingDaemon {
  readonly pid: number;
  readonly memory: MemoryReading;
  readonly limit: number;
}

// [LAW:single-enforcer] THE judgment of "near the limit": the restart
// forecast in daemon-stats asks it, and the render cache's share is sized
// under it.
export const NEAR_LIMIT = 0.75;

export function approachingLimit(bytes: number, limit: number): boolean {
  return bytes > limit * NEAR_LIMIT;
}

// [LAW:one-source-of-truth] The one spelling of a charge in a sentence: the
// breach line and the restart forecast say it this way.
export function chargeWords(charge: ReadCharge): string {
  return charge.kind === "charged"
    ? `${charge.measure} ${mb(charge.bytes)} MB`
    : `rss ${mb(charge.bytes + charge.gap)} MB${charge.gap === 0 ? "" : ` less its last ${mb(charge.gap)} MB gap`} (standing in: ${charge.unread})`;
}

// [LAW:one-source-of-truth] The one token naming what a charge measured: the
// per-check log line says it this way.
export function measureOf(charge: MemoryCharge): string {
  return charge.kind === "charged" ? charge.measure : "rss-stand-in";
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

// [LAW:one-source-of-truth] The artifacts a breach leaves, spelled ONCE. The
// writer names them from this table, the real lister filters by it, and rotation
// strips it to recover the `<stamp>-<pid>` identity the pair shares. Three
// independent spellings of one pair — which is what adding the memory report
// naively produced — is exactly how a rotation quietly stops matching what the
// writer emits, leaving a directory that grows forever or a heap snapshot whose
// attribution was evicted from under it.
// The renderer's heap is its own process's, so its snapshot is its own file.
export const BREACH_ARTIFACTS = {
  memoryReport: { prefix: "memory-", suffix: ".txt" },
  rendererHeapSnapshot: { prefix: "renderer-heap-", suffix: ".heapsnapshot" },
  heapSnapshot: { prefix: "heap-", suffix: ".heapsnapshot" },
} as const;

export type BreachArtifact = keyof typeof BREACH_ARTIFACTS;

// [LAW:types-are-the-program] The backstop's latest reading, or none yet:
// `unmeasured` until the first probe answers — the instant before a daemon's
// first check, and for good in the browser page, which never arms its limits.
// Never a construction-time number passed off as a reading.
// [LAW:one-source-of-truth] The limit is the daemon's whole: the charge,
// `rss` and `heapTotal` are over every process it runs as, and `processes`
// says each one's share, the host's first. A renderer in a process of its
// own is read as its latest ping answered, which goes out as it starts. Its
// pid is in the platform's charge from its spawn; where the charge is RSS
// (Linux, or a stand-in), it counts from its first ping's answer.
export type MemoryReading =
  | { readonly kind: "unmeasured" }
  | {
      readonly kind: "measured";
      readonly charge: ReadCharge;
      readonly rss: number;
      readonly heapTotal: number;
      readonly processes: readonly ProcessMemory[];
    };

export interface ProcessMemory {
  readonly role: "host" | "renderer";
  readonly pid: number;
  // Null for a renderer no ping has answered yet.
  readonly sizes: MemorySizes | null;
}

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
// stand-in since, 0 before any (and on Linux, whose charge IS RSS). `bytes` is
// what the limit judges either way.
export type ReadCharge =
  | Extract<MemoryCharge, { kind: "charged" }>
  | {
      readonly kind: "stand-in";
      readonly bytes: number;
      readonly gap: number;
      readonly unread: string;
    };
