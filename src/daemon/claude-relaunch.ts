// How a running Claude Code is started again on the same session: the
// arguments it was started with, less the ones that choose or create a
// session, plus `--resume <session id>` — so the conversation, its id, and
// every session pick the bar holds for that id carry over.
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

// What a flag consumes after it, as commander reads it: nothing, exactly one
// token, one token when the next does not start with `-`, or every token up
// to the next that does.
type Arity = "none" | "one" | "optional" | "variadic";

// A flag that is carried to the new start, or dropped from it because it
// chooses, creates, or detaches a session (or makes the run a one-shot): the
// relaunch chooses the session itself, with `--resume`.
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

export type Relaunch =
  | { readonly kind: "args"; readonly args: readonly string[] }
  | { readonly kind: "refused"; readonly reason: string };

const isFlag = (token: string): boolean =>
  token.startsWith("-") && token !== "-";

// The arguments that start Claude Code again on `sessionId`, from the argv it
// was started with (`argv[0]` the program). Positional words are the prompt
// the session opened with, which already ran, so they are dropped with the
// session-choosing flags.
export function relaunchArgs(
  argv: readonly string[],
  sessionId: string,
): Relaunch {
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
  return { kind: "args", args: [...kept, "--resume", sessionId] };
}

function takeWhile<T>(xs: readonly T[], ok: (x: T) => boolean): T[] {
  const end = xs.findIndex((x) => !ok(x));
  return end === -1 ? [...xs] : xs.slice(0, end);
}
