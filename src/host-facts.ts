// [LAW:effects-at-boundaries] What a process knows of the machine it runs on,
// read once by its main (src/host.ts) and handed down as a value: the
// environment, the home directory and the temporary directory. In-process code
// reads `home` and `tmp` from here and never from `env`, so the two cannot
// disagree inside src; `env` keeps both for the children that inherit it. A
// test builds one by hand instead of writing `process.env`.
export interface Host {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly home: string;
  readonly tmp: string;
}
