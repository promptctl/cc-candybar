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
