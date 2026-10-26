import fs from "node:fs";

// [LAW:no-ambient-temporal-coupling] A shell run that waits at a gate the test
// holds, so "the run is still out" is a state the test owns, never a race
// between the child's exit and an abort timer. The gate starts open; a test
// closes it before the move that starts the run it means to catch out, and
// opens it once it has looked.
export function shellGate(file: string) {
  const open = () => fs.writeFileSync(file, "");
  open();
  return {
    // The run is spawned detached, so a worker killed before it opens the gate
    // never disposes it. The wait gives up after about ten seconds and fails
    // the run rather than poll forever.
    hold: `i=0; until [ -e '${file}' ]; do [ $i -lt 1000 ] || exit 1; sleep 0.01; i=$((i+1)); done`,
    open,
    close: () => fs.rmSync(file),
  };
}
