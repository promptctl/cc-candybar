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
import { attachLauncherOf, PRELOAD_VARIABLE } from "./attach-launcher.js";
import { executableOn } from "./path-search.js";

export type ExecPlan =
  | {
      readonly kind: "exec";
      readonly file: string;
      readonly argv: readonly string[];
      readonly env: readonly string[];
    }
  | { readonly kind: "refused"; readonly why: string };

// One word of BUN_OPTIONS as Bun reads it (`text`: words split on unescaped
// whitespace, a backslash taking the next character as it is — measured:
// `--preload /a\ b/x.js` loads `/a b/x.js`; quotes are not read) beside the
// bytes it was read from (`raw`: `--preload=` keeps the backslash, measured,
// so that form's value is its raw bytes).
export interface BunWord {
  readonly text: string;
  readonly raw: string;
}

export function bunWords(options: string): BunWord[] {
  const words: BunWord[] = [];
  let text: string | null = null;
  let from = 0;
  for (let i = 0; i < options.length; i++) {
    const c = options[i]!;
    if (/\s/.test(c)) {
      if (text !== null) words.push({ text, raw: options.slice(from, i) });
      text = null;
      continue;
    }
    if (text === null) from = i;
    text =
      (text ?? "") + (c === "\\" && i + 1 < options.length ? options[++i] : c);
  }
  if (text !== null) words.push({ text, raw: options.slice(from) });
  return words;
}

// BUN_OPTIONS with this preload taken out, or null when nothing else is
// left. Taken out before anything starts: every Bun process the session
// starts — the Bash tool's `bun`, a hook, a nested `claude` — would inherit it
// and run this preload again. Every other word keeps the bytes it was typed
// with: only Bun knows what it makes of them.
export function withoutPreload(
  options: string,
  isSelf: (file: string) => boolean,
): string | null {
  const words = bunWords(options);
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    if ((w.text === "--preload" || w.text === "-r") && next !== undefined) {
      if (isSelf(next.text)) {
        i++;
        continue;
      }
    } else if (w.raw.startsWith("--preload=")) {
      if (isSelf(w.raw.slice("--preload=".length))) continue;
    }
    kept.push(w.raw);
  }
  return kept.length === 0 ? null : kept.join(" ");
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
  // A path with its links resolved (itself, absolute, when it names nothing):
  // the one identity a typed path and a loaded one share — `/tmp` is
  // `/private/tmp` on macOS, and Bun hands this file over resolved.
  readonly canonical: (file: string) => string;
}

// A Bun-compiled executable runs its entry from Bun's embedded filesystem
// (measured on Claude Code 2.1.289: `/$bunfs/root/cli`); `bun` itself runs a
// file on disk.
const COMPILED_ENTRY = "/$bunfs/";

// [LAW:types-are-the-program] The node the attach launcher runs under, or
// why there is none.
export type LauncherNode =
  | { readonly kind: "node"; readonly file: string }
  | { readonly kind: "refused"; readonly why: string };

// [LAW:single-enforcer] The node the attach launcher runs under: the first
// `node` on `pathVariable`, as the launcher's own `#!/usr/bin/env node` finds
// it — the shell `claude` was typed into is the only place that knows which
// node this user runs — and never Bun. The preload asks it at Claude Code's
// start, and lane B's restart asks it of the PATH Claude Code was started
// with before ending it (src/daemon/lane-setup.ts).
export function launcherNode(
  pathVariable: string | undefined,
  isExecutable: (file: string) => boolean,
  canonical: (file: string) => string,
): LauncherNode {
  const node = executableOn("node", pathVariable, isExecutable);
  if (node === null) {
    return {
      kind: "refused",
      why: "no `node` on PATH to run the attach launcher",
    };
  }
  // Bun puts a `node` that is Bun first on PATH (`bun run`, and a machine
  // with no Node); the launcher must run under Node.
  return path.basename(canonical(node)) === "bun"
    ? {
        kind: "refused",
        why: `the \`node\` on PATH (${node}) is Bun; the attach launcher runs under Node`,
      }
    : { kind: "node", file: node };
}

export function planExec(facts: PreloadFacts): ExecPlan {
  if (!(facts.argv[1] ?? "").startsWith(COMPILED_ENTRY)) {
    return {
      kind: "refused",
      why: `${facts.executable} is not a Bun-compiled Claude Code — put ${PRELOAD_VARIABLE} with this preload before \`claude\` alone, never export it`,
    };
  }
  const launcher = attachLauncherOf(facts.self);
  if (!facts.exists(launcher)) {
    return {
      kind: "refused",
      why: `the attach launcher is not at ${launcher} beside this preload — rebuild (\`pnpm build\`) or reinstall cc-candybar`,
    };
  }
  const node = launcherNode(
    facts.env.PATH,
    facts.isExecutable,
    facts.canonical,
  );
  if (node.kind === "refused") return node;
  const self = facts.canonical(facts.self);
  const isSelf = (file: string): boolean => facts.canonical(file) === self;
  const env: string[] = [];
  for (const [name, value] of Object.entries(facts.env)) {
    if (value === undefined) continue;
    if (name === PRELOAD_VARIABLE) {
      const left = withoutPreload(value, isSelf);
      if (left !== null) env.push(`${name}=${left}`);
      continue;
    }
    env.push(`${name}=${value}`);
  }
  return {
    kind: "exec",
    file: node.file,
    argv: [node.file, launcher, facts.executable, ...facts.argv.slice(2)],
    env,
  };
}
