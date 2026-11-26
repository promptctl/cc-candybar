// One run at a time of work that is asked for often: the pane's draw and its
// report of the pointer.
//
// [LAW:no-ambient-temporal-coupling] Whether a run is under way is state set
// before the work starts and cleared after it ends, so a body that finishes
// without waiting cannot leave the gate shut. A request that arrives during a
// run is the one run after it, never a queue: the run reads the state as it
// stands when it starts, so the newest request is the last one served.
export function singleFlight(
  run: () => Promise<void>,
  failed: (e: unknown) => void,
): () => void {
  let running = false;
  let due = false;
  return () => {
    due = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (due) {
          due = false;
          await run();
        }
      } finally {
        running = false;
      }
    })().catch(failed);
  };
}
