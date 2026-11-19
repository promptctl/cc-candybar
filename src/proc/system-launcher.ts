// [LAW:effects-at-boundaries] A launcher over this machine's own processes: the
// one pairing of launch.ts's decisions with the real OS. Whoever builds a
// launcher for a real process names it here; whoever tests the launch decisions
// builds `createLauncher` over a scripted `Spawner` instead.

import { createAdmittable, type Admittable, type LaunchOwner } from "./launch";
import { systemSpawner } from "./spawner";
import type { Timekeeper } from "../time";

// The launcher a started world (src/host.ts) is built over, with the one way
// to withhold names from it.
export const systemAdmittable = (
  owner: LaunchOwner,
  clock: Timekeeper,
): Admittable => createAdmittable(owner, clock, systemSpawner);
