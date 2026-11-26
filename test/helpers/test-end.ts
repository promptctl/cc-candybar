// The end of the running test, for a wait on what the machine decides: a real
// daemon's boot, or a free slot in the machine-wide daemon pool. How long either
// takes depends on whatever else the machine runs, every other worktree's suite
// included, so such a wait ends when it is answered or when its test ends, and
// the runner's timeout is the one bound on it. A wait still open when its test
// ends is told to stop, and its failure fails the test by name once its own
// cleanup has run.

let ending = new AbortController();
const open = new Set<Promise<unknown>>();

export function untilTestEnds<T>(
  wait: (ended: AbortSignal) => Promise<T>,
  what: string,
): Promise<T> {
  const { signal } = ending;
  const waiting = wait(signal).catch((error: unknown) => {
    if (!signal.aborted) throw error;
    throw new Error(`${what}: ${String(error)}`, { cause: error });
  });
  open.add(waiting);
  const settled = () => open.delete(waiting);
  waiting.then(settled, settled);
  return waiting;
}

async function end(): Promise<void> {
  const left = [...open];
  ending.abort(new Error("its test ended"));
  ending = new AbortController();
  const failed = (await Promise.allSettled(left)).flatMap((r) =>
    r.status === "rejected" ? [String((r.reason as Error).message)] : [],
  );
  if (failed.length > 0) {
    throw new Error(`a wait outlived its test:\n${failed.join("\n")}`);
  }
}

// A boot in a file's beforeAll has no test of its own, so the file's end ends it.
afterEach(end);
afterAll(end);
