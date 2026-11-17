// [LAW:dataflow-not-control-flow] [LAW:no-silent-failure] Every step runs, in
// order, whatever a step before it threw: each is its own error boundary. What
// they threw is thrown once they all have run (`throwAll`).
export function runEach(steps: Iterable<() => void>): void {
  const thrown: unknown[] = [];
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      thrown.push(error);
    }
  }
  throwAll(thrown);
}

// [LAW:single-enforcer] Every failure of steps that each ran however the
// last ended: a lone one is thrown as it is, so its class still classifies
// it, and several as one error naming each, so none replaces another.
export function throwAll(failures: readonly unknown[]): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      failures
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join("; "),
    );
}
