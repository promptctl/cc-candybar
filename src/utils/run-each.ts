// [LAW:dataflow-not-control-flow] [LAW:no-silent-failure] Every step runs, in
// order, whatever a step before it threw: each is its own error boundary. What
// they threw is thrown once they all have run, a lone throw as it was, so its
// class still classifies it, and several together.
export function runEach(steps: Iterable<() => void>): void {
  const thrown: unknown[] = [];
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      thrown.push(error);
    }
  }
  if (thrown.length === 1) throw thrown[0];
  if (thrown.length > 1)
    throw new AggregateError(thrown, `${thrown.length} steps threw`);
}
