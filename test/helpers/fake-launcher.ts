import {
  createOneShotLauncher,
  LIFELINE_PROGRAM,
  type LaunchOwner,
  type OneShotLauncher,
  type TestableLauncher,
} from "../../src/proc/launch";
import {
  fakeSpawner,
  readsStdin,
  type FakeSpawner,
  type Spawn,
} from "../../src/proc/spawner-fake";
import { systemTimekeeper, type Timekeeper } from "../../src/time";
import { SourceRuns } from "../../src/var-system/source-runs";

export interface FakeLauncher {
  readonly launcher: TestableLauncher & OneShotLauncher;
  // Where a test says what each program does, and reads what was started.
  readonly spawner: FakeSpawner;
  // The programs the test's own launches started: the launcher's lifeline is
  // its own and is in `spawner.spawned`, where the whole record is.
  readonly started: () => readonly Spawn[];
}

// A stream finishes its work on the next-tick queue, which a chain of resolved
// promises never leaves room for, so each turn waits on that queue itself.
export const turns = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => process.nextTick(resolve));
  }
};

const isLifeline = (s: Pick<Spawn, "bin" | "args">): boolean =>
  s.bin === "awk" && s.args[0] === LIFELINE_PROGRAM;

// [LAW:one-source-of-truth] The REAL launcher over a spawner a test scripts, so
// the timeout, the abort, the output bound, the rate limit and the owner's gate
// a test depends on are the production code, run on the clock it hands in. A
// program nobody registered fails to start, as a missing binary does.
//
// The lifeline's `awk` is registered the way any program is, from the program
// the launcher itself spawns it with: if the launcher changes how it starts the
// lifeline, that spawn stops matching and fails in every case that launches.
export function fakeLauncher(
  clock: Timekeeper,
  owner: Partial<LaunchOwner> = {},
): FakeLauncher {
  const spawner = fakeSpawner(clock);
  spawner.program(
    (bin, args) => isLifeline({ bin, args }),
    readsStdin("until-end"),
  );
  const launcher = createOneShotLauncher(
    { inherited: {}, ...owner },
    clock,
    spawner,
  );
  return {
    launcher,
    spawner,
    started: () => spawner.spawned.filter((s) => !isLifeline(s)),
  };
}

// A launcher for a test whose subject takes one and means to launch nothing: any
// launch fails as a missing program does, loudly, so a test that starts to
// spawn must say what it spawns.
export const unscriptedLauncher: FakeLauncher["launcher"] =
  fakeLauncher(systemTimekeeper).launcher;

// A source-runs owner over the unscripted launcher, for a registry whose
// sources never run: one per registry, so no test's holds reach another's.
export const unscriptedRuns = (): SourceRuns =>
  new SourceRuns({ launcher: unscriptedLauncher, clock: systemTimekeeper });
