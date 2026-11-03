import type { Timekeeper } from "../time";
import type { ProcessProbe } from "./process-fingerprint";

// [LAW:single-enforcer] One owner of the invariant "I must not outlive the
// process that spawned me." A *production* daemon is spawned detached and is
// SUPPOSED to outlive its spawner — the render-tick client exits, leaving a
// warm daemon — so it is anchored to nobody and this watchdog never fires. A
// daemon spawned by a *transient* process (the Jest worker) must die WITH it:
// on abnormal exit (SIGKILL, worker crash, suite timeout) the OS reparents the
// orphan to init and it survives forever. That orphan-to-init survival is the
// test-daemon leak. The spawner publishes its pid in the environment and every
// descendant inherits it, so even a detached grand-child daemon stays anchored
// to the original runner.
//
// [LAW:dataflow-not-control-flow] The watchdog runs the same poll every tick;
// whether it ever trips lives in the anchor VALUE (a pid to outlive, or
// nobody), derived once from the environment — never in a branch wrapped around
// the spawn path. Like the memory backstop in `limits.ts`, it calls `onOrphaned`
// (the lifecycle `shutdown`) rather than exiting itself, so every daemon-death
// path funnels through the one enforcer.

export const PARENT_PID_ENV = "CC_CANDYBAR_PARENT_PID";

// [LAW:verifiable-goals] Only ever consulted for an ANCHORED (test) daemon —
// "outlives-nobody" (the production daemon) arms no timer at all, so
// tightening this is invisible to production. A dead-runner orphan can live
// at most one poll tick before the watchdog trips; 250ms (down from 1000ms,
// brandon-daemon-lifecycle-gad.1) shrinks that window fourfold without
// meaningfully increasing CPU — polling a single `kill(pid,0)` 4x/sec is
// negligible next to the daemon work it guards.
const DEFAULT_POLL_INTERVAL_MS = 250;

export type LivenessAnchor =
  | { kind: "outlives-nobody" }
  | { kind: "anchored"; pid: number };

// [LAW:no-silent-failure] Three inputs, three outcomes, no overlap: absent →
// production (outlive nobody); a positive integer → anchor to it; present but
// malformed → throw. Only the test harness ever sets this variable, so a
// malformed value is a harness bug; silently degrading to "outlives-nobody"
// would re-open the very leak this module closes.
export function anchorFromEnv(env: NodeJS.ProcessEnv): LivenessAnchor {
  const raw = env[PARENT_PID_ENV];
  if (raw === undefined) return { kind: "outlives-nobody" };
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      `${PARENT_PID_ENV} must be a positive integer pid, got ${JSON.stringify(raw)}`,
    );
  }
  return { kind: "anchored", pid };
}

export interface ParentWatchdogDeps {
  // The machine's clock: the poll runs in real time, beside a real process.
  clock: Pick<Timekeeper, "every">;
  anchor: LivenessAnchor;
  probe: Pick<ProcessProbe, "alive">;
  onOrphaned: (reason: string) => void;
  intervalMs?: number;
}

export function armParentWatchdog(deps: ParentWatchdogDeps): {
  disarm(): void;
} {
  // An unanchored daemon has nothing to poll — arming a perpetual no-op timer on
  // the user's always-running daemon would be pure waste. Returning an inert
  // handle is the consequence of the data, not a special case in the spawn path.
  if (deps.anchor.kind === "outlives-nobody") return { disarm: () => {} };

  const { pid } = deps.anchor;
  const disarm = deps.clock.every(
    deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    () => {
      if (!deps.probe.alive(pid)) deps.onOrphaned(`spawner pid ${pid} gone`);
    },
    { unref: true },
  );
  return { disarm };
}
