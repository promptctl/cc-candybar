// How a running Claude Code is started again on the same session, in the
// directory it runs in: with the arguments it was started with, less the ones
// that choose or create a session, plus `--resume <session id>` — or, for a
// session with no conversation yet, `--session-id <session id>` — so the
// conversation, its id, and every session pick the bar holds for that id
// carry over. A session running in a worktree Claude Code made is started
// from that worktree's repository with `--worktree <name>`, the line Claude
// Code prints itself when it exits (`claude --worktree <name> --resume <id>`,
// measured on 2.1.289).
//
// [LAW:parse-dont-validate] The argv a process was started with is untrusted
// shape: it is read the way Claude Code's own option parser (commander) reads
// it, flag by flag from the table below, and anything the table does not name
// is refused rather than guessed at — a flag whose arity is unknown could
// swallow, or leave behind, the token after it, and the session would come
// back started differently from how it ran.
//
// Measured on Claude Code 2.1.289: `--resume <id>` keeps the session id
// (`claude -p --resume <id> --output-format json` answers the same id).
// `--session-id <id>` starts a fresh session under that id, and is refused
// ("Session ID … is already in use") once the id has a transcript. A session
// ended by SIGTERM before its first message leaves no transcript, and
// `--session-id` then starts it again under the same id.

import path from "node:path";

// What a flag consumes after it, as commander reads it: nothing, exactly one
// token, one token when the next does not start with `-`, or every token up
// to the next that does.
type Arity = "none" | "one" | "optional" | "variadic";

// A flag that is carried to the new start, or dropped from it because it
// chooses, creates, or detaches a session (or makes the run a one-shot): the
// relaunch chooses the session itself (`SessionStart`). `--worktree` is
// dropped too: the worktree a session runs in is read off the directory it
// runs in, which a worktree entered mid-session moves as well.
interface FlagRule {
  readonly arity: Arity;
  readonly keep: boolean;
}

const keep = (arity: Arity): FlagRule => ({ arity, keep: true });
const drop = (arity: Arity): FlagRule => ({ arity, keep: false });

// [LAW:one-source-of-truth] Every option `claude --help` lists on 2.1.289,
// each spelling a row.
const FLAGS: Readonly<Record<string, FlagRule>> = {
  "--add-dir": keep("variadic"),
  "--agent": keep("one"),
  "--agents": keep("one"),
  "--allow-dangerously-skip-permissions": keep("none"),
  "--allowedTools": keep("variadic"),
  "--allowed-tools": keep("variadic"),
  "--append-system-prompt": keep("one"),
  "--autocompact": keep("one"),
  "--ax-screen-reader": keep("none"),
  "--bg": drop("none"),
  "--background": drop("none"),
  "--bare": keep("none"),
  "--betas": keep("variadic"),
  "--brief": keep("none"),
  "--chrome": keep("none"),
  "--cloud": drop("optional"),
  "-c": drop("none"),
  "--continue": drop("none"),
  "--dangerously-skip-permissions": keep("none"),
  "-d": keep("optional"),
  "--debug": keep("optional"),
  "--debug-file": keep("one"),
  "--desktop": drop("none"),
  "--disable-slash-commands": keep("none"),
  "--disallowedTools": keep("variadic"),
  "--disallowed-tools": keep("variadic"),
  "--effort": keep("one"),
  "--environment": drop("one"),
  "--exclude-dynamic-system-prompt-sections": keep("none"),
  "--fallback-model": keep("one"),
  "--file": keep("variadic"),
  "--fork-session": drop("none"),
  "--forward-subagent-text": keep("none"),
  "--from-pr": drop("optional"),
  "-h": drop("none"),
  "--help": drop("none"),
  "--ide": keep("none"),
  "--include-hook-events": keep("none"),
  "--include-partial-messages": keep("none"),
  "--input-format": keep("one"),
  "--json-schema": keep("one"),
  "--max-budget-usd": keep("one"),
  "--mcp-config": keep("variadic"),
  "--model": keep("one"),
  "-n": keep("one"),
  "--name": keep("one"),
  "--no-chrome": keep("none"),
  "--no-session-persistence": keep("none"),
  "--output-format": keep("one"),
  "--permission-mode": keep("one"),
  "--permission-prompts": keep("one"),
  "--plugin-dir": keep("one"),
  "--plugin-url": keep("one"),
  "-p": drop("none"),
  "--print": drop("none"),
  "--prompt-suggestions": keep("optional"),
  "--remote-control": keep("optional"),
  "--remote-control-session-name-prefix": keep("one"),
  "--replay-user-messages": keep("none"),
  "--restricted": keep("none"),
  "-r": drop("optional"),
  "--resume": drop("optional"),
  "--safe-mode": keep("none"),
  "--session-id": drop("one"),
  "--setting-sources": keep("one"),
  "--settings": keep("one"),
  "--strict-mcp-config": keep("none"),
  "--system-prompt": keep("one"),
  "--system-prompt-snapshot": keep("one"),
  "--teleport": drop("optional"),
  // `--tmux` makes a tmux session for the worktree `--worktree` creates.
  "--tmux": drop("none"),
  "--tools": keep("variadic"),
  "--verbose": keep("none"),
  "-v": drop("none"),
  "--version": drop("none"),
  "-w": drop("optional"),
  "--worktree": drop("optional"),
};

// [LAW:types-are-the-program] A restart: the directory to start in and the
// arguments to start with, or why there is none.
export type Relaunch =
  | {
      readonly kind: "relaunch";
      readonly dir: string;
      readonly args: readonly string[];
    }
  | { readonly kind: "refused"; readonly reason: string };

// The process a restart starts again, as read off it: the argv it was started
// with (`argv[0]` the program) and the directory it runs in.
export interface StartedProcess {
  readonly argv: readonly string[];
  readonly cwd: string;
}

// [LAW:types-are-the-program] The session a restart starts on: its
// conversation resumed, or, when it has none yet, a fresh start under the
// same id — `--resume` of a session with no transcript finds no conversation.
// Either way the id carries over, so the session's picks, and anything
// waiting on the restarted session, still name it.
export interface SessionStart {
  readonly kind: "resume" | "fresh";
  readonly sessionId: string;
}

const SESSION_FLAG: Readonly<Record<SessionStart["kind"], string>> = {
  resume: "--resume",
  fresh: "--session-id",
};

const isFlag = (token: string): boolean =>
  token.startsWith("-") && token !== "-";

// How `claude` is started again on `start`, in the directory it runs in.
// [LAW:one-source-of-truth] That directory alone says whether the session
// runs in a worktree — `--worktree` at the start and a worktree entered
// mid-session both move it, and leaving the worktree moves it back — so a
// worktree is carried as `--worktree <name>`, started from the repository
// that holds it, and anything else starts where it runs.
export function relaunchOf(
  claude: StartedProcess,
  start: SessionStart,
): Relaunch {
  const args = relaunchArgs(claude.argv, start);
  if (args.kind === "refused") return args;
  const tree = worktreeOf(claude.cwd);
  return tree === null
    ? { kind: "relaunch", dir: claude.cwd, args: args.args }
    : {
        kind: "relaunch",
        dir: tree.repo,
        args: ["--worktree", tree.name, ...args.args],
      };
}

// The arguments that start Claude Code again on `start`, from the argv it
// was started with (`argv[0]` the program). Positional words are the prompt the session opened with, which already ran,
// so they are dropped with the session-choosing flags.
function relaunchArgs(
  argv: readonly string[],
  start: SessionStart,
):
  | { readonly kind: "args"; readonly args: readonly string[] }
  | { readonly kind: "refused"; readonly reason: string } {
  const kept: string[] = [];
  const tokens = argv.slice(1);
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    i += 1;
    // `--` ends the options: everything after it is the opening prompt.
    if (token === "--") break;
    if (!isFlag(token)) continue;
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    const rule = FLAGS[name];
    if (rule === undefined) {
      return {
        kind: "refused",
        reason: `Claude Code was started with ${name}, which cc-candybar does not know how to carry to a restart`,
      };
    }
    // `--flag=value` carries its value in the token itself.
    const taken =
      eq !== -1
        ? []
        : rule.arity === "one"
          ? tokens.slice(i, i + 1)
          : rule.arity === "optional"
            ? tokens.slice(i, i + 1).filter((t) => !isFlag(t))
            : rule.arity === "variadic"
              ? takeWhile(tokens.slice(i), (t) => !isFlag(t))
              : [];
    if (rule.arity === "one" && eq === -1 && taken.length === 0) {
      return {
        kind: "refused",
        reason: `Claude Code was started with ${name} and no value after it`,
      };
    }
    i += taken.length;
    if (rule.keep) kept.push(token, ...taken);
  }
  return {
    kind: "args",
    args: [...kept, SESSION_FLAG[start.kind], start.sessionId],
  };
}

// The worktree Claude Code made that `dir` lies in, or null when it lies in
// none: Claude Code makes a worktree at `<repo>/.claude/worktrees/<name>` with
// each `/` of the name spelled `+`, and refuses a `+` in a name, so the
// directory's name reads back as the one name that reaches it (measured on
// 2.1.289: `--worktree feat/x.y` makes `feat+x.y`, `--worktree feat+x.y` is
// refused). `dir` may be below the worktree's top; the innermost worktree
// holding it is the one it runs in.
function worktreeOf(
  dir: string,
): { readonly repo: string; readonly name: string } | null {
  const parts = dir.split(path.sep);
  const at = parts.findLastIndex(
    (p, i) =>
      p === "worktrees" && parts[i - 1] === ".claude" && i + 1 < parts.length,
  );
  return at === -1
    ? null
    : {
        repo: parts.slice(0, at - 1).join(path.sep) || path.sep,
        name: parts[at + 1]!.replaceAll("+", "/"),
      };
}

function takeWhile<T>(xs: readonly T[], ok: (x: T) => boolean): T[] {
  const end = xs.findIndex((x) => !ok(x));
  return end === -1 ? [...xs] : xs.slice(0, end);
}
