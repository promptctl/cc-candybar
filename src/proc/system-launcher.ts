// [LAW:effects-at-boundaries] A launcher over this machine's own processes: the
// one pairing of launch.ts's decisions with the real OS. Whoever builds a
// launcher for a real process names it here; whoever tests the launch decisions
// builds `createLauncher` over a scripted `Spawner` instead.

import {
  createLauncher,
  createOneShotLauncher,
  type LaunchOwner,
  type OneShotLauncher,
  type TestableLauncher,
} from "./launch";
import { askOnce, type ReaderLauncher } from "./repository-vars";
import { systemSpawner } from "./spawner";
import type { Timekeeper } from "../time";

export const systemLauncher = (
  owner: LaunchOwner,
  clock: Timekeeper,
): TestableLauncher => createLauncher(owner, clock, systemSpawner);

export const systemOneShotLauncher = (
  owner: LaunchOwner,
  clock: Timekeeper,
): TestableLauncher & OneShotLauncher =>
  createOneShotLauncher(owner, clock, systemSpawner);

// [LAW:single-enforcer] A repository reader's launcher: it owns git's answer,
// which it asks through itself in an environment of its own (the inherited one
// whole, since asking which variables to withhold reads none of them).
export function systemReaderLauncher(
  owner: Omit<LaunchOwner, "withholds">,
  clock: Timekeeper,
  timeoutMs: number,
): ReaderLauncher {
  const repositoryVars = askOnce(
    (opts) =>
      launcher.launchSync({ ...opts, environment: whole(owner.inherited) }),
    timeoutMs,
  );
  const launcher = systemOneShotLauncher(
    { ...owner, withholds: repositoryVars },
    clock,
  );
  return { ...launcher, repositoryVars };
}

// A daemon's own launcher, over its scope, withholding by the answer its
// process's reader launcher owns: one answer for both.
export const systemScopedReader = (
  owner: Omit<LaunchOwner, "withholds">,
  reader: ReaderLauncher,
  clock: Timekeeper,
): TestableLauncher =>
  systemLauncher({ ...owner, withholds: reader.repositoryVars }, clock);

const whole = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
