import process from "node:process";

// [LAW:single-enforcer] A daemon spawned by a transient process (a Jest worker) must die
// WITH it; the spawner's pid rides the environment, so every descendant stays anchored.
// [LAW:dataflow-not-control-flow] Whether it ever trips lives in the anchor VALUE, and it
// calls `onOrphaned` so every daemon-death path funnels through the one enforcer.

export const PARENT_PID_ENV = "CC_CANDYBAR_PARENT_PID";

// [LAW:verifiable-goals] Bounds an orphan's life; only an anchored (test) daemon polls.
const DEFAULT_POLL_INTERVAL_MS = 250;

export type LivenessAnchor =
  | { kind: "outlives-nobody" }
  | { kind: "anchored"; pid: number };

// [LAW:no-silent-fallbacks] A malformed pid read as "outlives-nobody" re-opens the leak.
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
  anchor: LivenessAnchor;
  isAlive: (pid: number) => boolean;
  onOrphaned: (reason: string) => void;
  intervalMs?: number;
}

export function armParentWatchdog(deps: ParentWatchdogDeps): {
  disarm(): void;
} {
  if (deps.anchor.kind === "outlives-nobody") return { disarm: () => {} };

  const { pid } = deps.anchor;
  const timer = setInterval(() => {
    if (!deps.isAlive(pid)) deps.onOrphaned(`spawner pid ${pid} gone`);
  }, deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  timer.unref();
  return { disarm: () => clearInterval(timer) };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM is a live process we don't own: a reused pid must never orphan us.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
