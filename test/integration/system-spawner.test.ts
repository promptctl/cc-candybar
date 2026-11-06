import { systemSpawner } from "../../src/proc/spawner";
import type { Behaviour } from "../../src/proc/spawner-fake";
import { spawnerContract, type Program } from "../contract/spawner.contract";

const quoted = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

// A behaviour as the `/bin/sh` script that does it. Every program here leads
// its own group when spawned detached, as a launch's child does, and the
// contract ends a hung one by that group.
function script(b: Behaviour): string {
  const steps: string[] = [];
  // The trap comes before any output, so output says the trap is set.
  if (b.ignores?.includes("SIGTERM")) steps.push("trap '' TERM");
  if (b.stdout) steps.push(`printf %s ${quoted(b.stdout)}`);
  if (b.stderr) steps.push(`printf %s ${quoted(b.stderr)} >&2`);
  if (b.floods) steps.push(`head -c ${b.floods} /dev/zero | tr '\\0' x`);
  if (b.stdin === "echo") steps.push("cat");
  else if (b.stdin === "until-end") steps.push("cat >/dev/null");
  else if (!Number.isFinite(b.runsFor)) steps.push("sleep 600");
  else if (b.runsFor > 0) steps.push(`sleep ${b.runsFor / 1000}`);
  steps.push(`exit ${b.stdin === undefined ? b.exitCode : 0}`);
  return steps.join("; ");
}

spawnerContract("the system spawner", () => ({
  spawner: systemSpawner,
  realise: (b): Program => ({ bin: "/bin/sh", args: ["-c", script(b)] }),
  missing: { bin: "/nonexistent/spawner-contract-program", args: [] },
  settle: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}));
