// [LAW:effects-at-boundaries] What a process knows of the machine it runs on,
// read once by its main (src/host.ts) and handed down as a value: the
// environment, the home directory and the temporary directory. In-process code
// reads `home` and `tmp` from here and never from `env`, so the two cannot
// disagree inside src; `env` keeps both for the children that inherit it. A
// test builds one with `hostOf` instead of writing `process.env`.
export interface Host {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly home: string;
  readonly tmp: string;
  // [LAW:one-source-of-truth] The variables that locate a repository, which
  // the process removed from `env` as its world was built (src/host.ts), so no
  // child it launches reads the repository of the shell that started it.
  readonly dropped: DroppedEnv;
}

export interface DroppedEnv {
  // Every name removed: the ones git names, and the forge's.
  readonly names: readonly string[];
  // The value each had that was set. A process that reports its own
  // environment as a session's (a statusline client, `check`, the doctor)
  // reports these too: there they are the session's own.
  readonly values: Readonly<Record<string, string>>;
  // [LAW:no-silent-failure] Why git's own list was not taken, so the fixed
  // list stood in, which may miss a variable this git reads; null when git
  // named them.
  readonly fault: string | null;
}

// [LAW:one-source-of-truth] What a drop removed, as the log and the doctor
// say it: the variables that were set, then every name that was unset.
export function describeDropped({ names, values }: DroppedEnv): string {
  const set = Object.keys(values);
  return `${set.length === 0 ? "none was set" : `${set.join(", ")} unset`} of the variables that locate a repository (${names.join(" ")})`;
}
