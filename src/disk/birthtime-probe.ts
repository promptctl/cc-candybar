import { plusMs, type Timekeeper } from "../time";

// Whether the disk's stat supplies a folder's birth time. libuv reads it with
// statx; where statx fails (an old kernel, a seccomp filter) libuv stops
// trying for the life of the process and copies ctime into birth time, and a
// directory's ctime moves on every child create, remove or rename. A ctime
// copy in a folder's identity (src/utils/folder-identity.ts) would make every
// write in a folder read as another folder, so the adapter asks once which
// host it is on.
//
// `supplied`: birth time stayed put while ctime moved, or ctime never moved
// within the bound, which is no evidence against it. `ctime`: birth time moved
// with ctime. `unprobed`: the probe could not run, and birth time is read as
// the disk gives it.
//
// Known gap: libuv also gives up on statx at its first EOPNOTSUPP, which
// depends on the path (a DVS mount), so a process that probed `supplied` can
// fall back later. Probing again is not worth it for this daemon.
export type BirthtimeVerdict =
  | { readonly kind: "supplied" }
  | { readonly kind: "ctime" }
  | { readonly kind: "unprobed"; readonly reason: string };

export interface ProbeStat {
  readonly birthtimeNs: bigint;
  readonly ctimeNs: bigint;
}

// [LAW:effects-at-boundaries] The probe's steps, as the adapter binds them to
// `fs`: a scratch folder, its stat, a metadata write that moves its ctime, and
// its removal.
export interface ProbeSteps {
  makeFolder(): string;
  stat(folder: string): ProbeStat;
  touch(folder: string): void;
  remove(folder: string): void;
}

// The probe runs synchronously inside the process's first stat, so it waits
// for ctime to tick for this long at most. Linux stamps ctime from a coarse
// clock that ticks every 1 to 10 ms, so a few ticks fit well inside it.
export const CTIME_WAIT_MS = 50;

const verdictIn = (
  steps: ProbeSteps,
  clock: Pick<Timekeeper, "monotonic">,
  folder: string,
): BirthtimeVerdict => {
  const before = steps.stat(folder);
  const until = plusMs(clock.monotonic(), CTIME_WAIT_MS);
  let after = before;
  while (after.ctimeNs === before.ctimeNs && clock.monotonic() < until) {
    steps.touch(folder);
    after = steps.stat(folder);
  }
  return after.ctimeNs !== before.ctimeNs &&
    after.birthtimeNs !== before.birthtimeNs
    ? { kind: "ctime" }
    : { kind: "supplied" };
};

export const probeBirthtime = (
  steps: ProbeSteps,
  clock: Pick<Timekeeper, "monotonic">,
): BirthtimeVerdict => {
  try {
    const folder = steps.makeFolder();
    try {
      return verdictIn(steps, clock, folder);
    } finally {
      steps.remove(folder);
    }
  } catch (e) {
    // [LAW:no-silent-failure] The reason rides the verdict to the daemon's
    // startup line; birth time stays as read, which is no worse than before.
    return { kind: "unprobed", reason: (e as Error).message };
  }
};

// [LAW:one-source-of-truth] One spelling of "no birth time" for both causes:
// the host copies ctime into it, or statx reports 0 on a filesystem that
// keeps none.
export const birthtimeOf = (
  verdict: BirthtimeVerdict,
  birthtimeNs: bigint,
): bigint | null =>
  verdict.kind === "ctime" || birthtimeNs === 0n ? null : birthtimeNs;

// The verdict as the daemon's startup line says it.
export const describeBirthtime = (verdict: BirthtimeVerdict): string =>
  verdict.kind === "supplied"
    ? "birth time: supplied by the disk"
    : verdict.kind === "ctime"
      ? "birth time: a copy of ctime on this host (no statx), so folder identity is device and inode"
      : `birth time: unprobed (${verdict.reason}), read as the disk gives it`;
