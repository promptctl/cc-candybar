// The shape every benchmark shares. A benchmark is a value, not a function per
// case: the widths, presets, session counts and transcript sizes are tables
// that `.map` into benchmarks, so a new case is a new row of data.
//
// [LAW:one-type-per-behavior] A case that differs from another only in a
// number or a path is the same benchmark with other data.

// What a statusline tick pays, in the order it pays it.
export const GROUPS = ["stages", "sources", "wire", "client"] as const;
export type Group = (typeof GROUPS)[number];

// One timed quantity of a run, in ms. A run can time several at once: the
// client's round trip and the daemon's own `took` come from the same ticks.
export interface Series {
  readonly name: string;
  readonly samples: readonly number[];
}

// What a run learned that is not a timing but belongs beside one: how many
// bytes the bar drew, how many entries a reload held. A number that moves
// without the timing moving is how a benchmark that stopped measuring shows.
export type Facts = Readonly<Record<string, number | string>>;

// [LAW:types-are-the-program] Three ways a benchmark ends, none of them a
// missing row. `skipped` is a precondition the machine does not meet (the
// native client is not built); `failed` is a benchmark that could not vouch for
// its own samples. Both stay in the report, so "did not run" and "ran and was
// fast" are never confused.
export type Outcome =
  | {
      readonly kind: "measured";
      readonly series: readonly Series[];
      readonly facts: Facts;
    }
  | { readonly kind: "skipped"; readonly reason: string };

export interface Plan {
  // The repetitions this run times: the benchmark's own count, scaled.
  readonly samples: number;
  readonly note: (line: string) => void;
}

export interface Benchmark {
  // Dotted, group first: `wire.tick.w120`. `--only` selects by prefix.
  readonly id: string;
  readonly group: Group;
  readonly about: string;
  // Repetitions at scale 1.
  readonly samples: number;
  run(plan: Plan): Promise<Outcome>;
}

export function measured(
  series: readonly Series[],
  facts: Facts = {},
): Outcome {
  return { kind: "measured", series, facts };
}

export function skipped(reason: string): Outcome {
  return { kind: "skipped", reason };
}
