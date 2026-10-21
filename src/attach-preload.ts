// The preload that starts Claude Code under the attach launcher from one
// environment variable: `BUN_OPTIONS='--preload <dist>/attach-preload.cjs'
// claude` (`attachCommandLine`, src/attach-launcher.ts). A Bun-compiled
// Claude Code honours BUN_OPTIONS (it ignores BUN_INSPECT_PRELOAD, and
// NODE_OPTIONS — measured on 2.1.289), so this runs inside the `claude`
// process, before a line of the app: nothing has compiled, nothing has drawn,
// and the terminal is as the shell left it. It replaces the process (execve,
// same pid) with `node bun-attach.js <this binary> <its arguments>` — the
// command lane B's restart starts — so the pane's job is the launcher, as
// after a restart, and lane B reads it as attached (`runsAttached`,
// src/daemon/lane-edge.ts).
//
// Why exec and not spawn-and-wait: a parent left waiting would be a second
// process for every signal, every job-control stop and the exit status to
// pass through, and the launcher already supervises the child it starts.
//
// Why not BUN_INSPECT: one variable names one socket, so a second session
// started with it could not bind its inspector; BUN_INSPECT_CONNECT_TO dials
// out ~280 ms in without holding the process, after the app has compiled
// with no debugger attached (measured on 2.1.289).
//
// [LAW:effects-at-boundaries] `planExec` is the whole decision, pure; the
// effect is one execve. [LAW:no-silent-failure] What cannot be attached is
// said and exits non-zero: never a stock session, which would look like the
// attached one that failed.

import path from "node:path";
import { attachLauncherOf } from "./attach-launcher.js";

export const PRELOAD_VARIABLE = "BUN_OPTIONS";

export type ExecPlan =
  | {
      readonly kind: "exec";
      readonly file: string;
      readonly argv: readonly string[];
      readonly env: readonly string[];
    }
  | { readonly kind: "refused"; readonly why: string };

// Bun's reading of BUN_OPTIONS: words split on unescaped whitespace, a
// backslash taking the next character as it is (measured: `--preload
// /a\ b/x.js` loads `/a b/x.js`; quotes are not read, and `--preload=` keeps
// the backslash).
export function bunWords(options: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < options.length; i++) {
    const c = options[i]!;
    if (c === "\\" && i + 1 < options.length) {
      word = (word ?? "") + options[++i];
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

const escapedWord = (w: string): string => w.replace(/[\\\s]/g, "\\$&");

// BUN_OPTIONS with this preload taken out, or null when nothing else is
// left. Taken out before anything starts: every Bun process the session
// starts — the Bash tool's `bun`, a hook, a nested `claude` — would inherit it
// and run this preload again.
export function withoutPreload(options: string, self: string): string | null {
  const words = bunWords(options);
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if ((w === "--preload" || w === "-r") && i + 1 < words.length) {
      if (path.resolve(words[i + 1]!) === self) {
        i++;
        continue;
      }
    } else if (w.startsWith("--preload=")) {
      if (path.resolve(w.slice("--preload=".length)) === self) continue;
    }
    kept.push(w);
  }
  return kept.length === 0 ? null : kept.map(escapedWord).join(" ");
}

// The first `node` on `pathVariable`, as the launcher's own `#!/usr/bin/env
// node` would find it — the shell `claude` was typed into is the only place
// that knows which node this user runs. Only absolute entries: a relative one
// would resolve against whatever directory the session was started in.
export function nodeOn(
  pathVariable: string | undefined,
  isExecutable: (file: string) => boolean,
): string | null {
  for (const dir of (pathVariable ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const node = path.join(dir, "node");
    if (isExecutable(node)) return node;
  }
  return null;
}

export interface PreloadFacts {
  // This file, as Bun loaded it.
  readonly self: string;
  // The binary running it: Claude Code's release, links resolved.
  readonly executable: string;
  // `process.argv`: `bun`, the compiled entry, then the user's arguments.
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  // The launcher is a script node reads, so it need only exist; `node` must
  // run.
  readonly exists: (file: string) => boolean;
  readonly isExecutable: (file: string) => boolean;
}

export function planExec(facts: PreloadFacts): ExecPlan {
  const launcher = attachLauncherOf(facts.self);
  if (!facts.exists(launcher)) {
    return {
      kind: "refused",
      why: `the attach launcher is not at ${launcher} beside this preload — rebuild (\`pnpm build\`) or reinstall cc-candybar`,
    };
  }
  const node = nodeOn(facts.env.PATH, facts.isExecutable);
  if (node === null) {
    return {
      kind: "refused",
      why: "no `node` on PATH to run the attach launcher",
    };
  }
  const env: string[] = [];
  for (const [name, value] of Object.entries(facts.env)) {
    if (value === undefined) continue;
    if (name === PRELOAD_VARIABLE) {
      const left = withoutPreload(value, facts.self);
      if (left !== null) env.push(`${name}=${left}`);
      continue;
    }
    env.push(`${name}=${value}`);
  }
  return {
    kind: "exec",
    file: node,
    argv: [node, launcher, facts.executable, ...facts.argv.slice(2)],
    env,
  };
}
