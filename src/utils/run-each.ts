import { diagnosticMessage } from "./describe-value.js";

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

// [LAW:single-enforcer] What several error boundaries caught, thrown as one: a
// lone throw as it was, so its class still classifies it, and several together,
// each one's message in the whole's, whatever was thrown.
export function throwAll(thrown: readonly unknown[]): void {
  if (thrown.length === 1) throw thrown[0];
  if (thrown.length > 1)
    throw new AggregateError(thrown, thrown.map(diagnosticMessage).join("; "));
}
