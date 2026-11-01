// The effects a lane's setup performs (src/daemon/lane-setup.ts): tmux calls
// against the session's recorded server, the `claude` CLI, the process table,
// and the PATH lookup. Every one is awaited, off the daemon's loop.
//
// [LAW:single-enforcer] Every spawn goes through src/proc/launch (tmux through
// src/proc/tmux), under its own launch category.

import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { LaunchResult, Launcher } from "../proc/launch.js";
import { runTmuxAsync } from "../proc/tmux.js";
import type { TmuxHint } from "../tmux-hint.js";
import type { Lane } from "../config/lanes.js";
import {
  pasteLineArgs,
  productionClaudeInputEdge,
} from "../claude-input/edge.js";
import { lineage, processTable } from "../proc/process-table.js";
import { pidAlive } from "./parent-watchdog.js";
import { presence } from "../utils/presence.js";
import { sessionEnv } from "./session-env.js";
import { canonical, executableOn, regularFileWith } from "../path-search.js";
import { launcherNode } from "../attach-preload.js";
import {
  BAR_PANE_OPTION,
  type LaneEdge,
  type PaneClaude,
} from "./lane-setup.js";

const SHELL_BUFFER = "cc-candybar-lane";
// How often the wait for an exit looks again.
const EXIT_POLL_MS = 100;
// How long a shell has to take its terminal back once Claude Code exited.
const SHELL_PATIENCE_MS = 2000;

async function tmux(
  launcher: Launcher,
  hint: TmuxHint,
  args: string[],
  stdinInput?: string,
): Promise<string> {
  const run = await runTmuxAsync(launcher, hint, "lane.tmux", args, stdinInput);
  if (run.kind !== "ok") throw new Error(run.reason);
  return run.stdout;
}

function ran(what: string, result: LaunchResult): string {
  if (result.ok) return result.stdout;
  const detail =
    result.error ??
    [result.reason, result.stderr.trim(), result.stdout.trim()]
      .filter((s) => s !== "")
      .join(": ");
  throw new Error(`${what} failed (${detail})`);
}

// [LAW:parse-dont-validate] The module graph reader's refusal: one JSON line,
// `{ ok: false, reason, detail? }` (vendor/cc-extra/src/bun-graph.js), read
// to its reason — or null when its output is not that line.
export function refusalOf(stdout: string): string | null {
  try {
    const said = JSON.parse(stdout) as unknown;
    if (
      typeof said === "object" &&
      said !== null &&
      "ok" in said &&
      said.ok === false &&
      "reason" in said &&
      typeof said.reason === "string"
    ) {
      return "detail" in said && typeof said.detail === "string"
        ? `${said.reason}: ${said.detail}`
        : said.reason;
    }
  } catch {
    // Not JSON: the reader failed before it could answer.
  }
  return null;
}

// [LAW:effects-at-boundaries] Pure over tmux's `list-panes -a` in
// `PANE_TAGS_FORMAT`: the bar panes tagged as drawing `pane`'s bar.
const PANE_TAGS_FORMAT = `#{pane_id} #{${BAR_PANE_OPTION}}`;
export function taggedBarPanes(listPanes: string, pane: string): string[] {
  return listPanes
    .split("\n")
    .map((line) => line.trim().split(" "))
    .filter(([, tag]) => tag === pane)
    .map(([id]) => id!);
}

// The words a cc-extra attach launcher runs under: the one shipped beside the
// bundle (src/attach-launcher.ts) runs `bun-attach.js`, and cc-extra's own
// `bin/cc-attach` runs it too.
const ATTACH = /(^|\/)(cc-attach|bun-attach\.js)(\s|$)/;

// [LAW:effects-at-boundaries] Pure over `ps -A -o pid=,ppid=,args=`: whether
// `pid`, or a process it descends from up to and including the pane's own
// first process, is a cc-extra attach launcher.
export function runsAttached(
  table: string,
  pid: number,
  panePid: number,
): boolean {
  for (const p of lineage(processTable(table), pid)) {
    if (p.command.split(" ").some((word) => ATTACH.test(word))) return true;
    if (p.pid === panePid) return false;
  }
  return false;
}

// The executable a process runs and the exact argv it was started with —
// `ps` joins argv with spaces, which a value holding a space would make
// ambiguous. Linux keeps both in /proc; macOS answers them through sysctl's
// KERN_PROCARGS2 (argc, then the executable path, padding, then argv, then
// the environment it was started with, each NUL-terminated; an empty string
// ends the environment, and the loader's own `key=value` strings follow it),
// read here with python3's ctypes since node has no sysctl. Linux keeps the
// environment in /proc too.
const PROCARGS2 = [
  "import ctypes, json, struct, sys",
  "libc = ctypes.CDLL(None)",
  "mib = (ctypes.c_int * 3)(1, 49, int(sys.argv[1]))",
  "size = ctypes.c_size_t(0)",
  "if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0: sys.exit('sysctl KERN_PROCARGS2 refused')",
  "buf = ctypes.create_string_buffer(size.value)",
  "if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0: sys.exit('sysctl KERN_PROCARGS2 refused')",
  "raw = buf.raw[:size.value]",
  "argc = struct.unpack_from('i', raw)[0]",
  "rest = raw[4:]",
  "end = rest.index(b'\\0')",
  "exe = rest[:end].decode('utf-8', 'surrogateescape')",
  "rest = rest[end:].lstrip(b'\\0')",
  "words = [w.decode('utf-8', 'surrogateescape') for w in rest.split(b'\\0')]",
  "end = words.index('', argc) if '' in words[argc:] else len(words)",
  "print(json.dumps({'executable': exe, 'argv': words[:argc], 'env': words[argc:end]}))",
].join("\n");

interface ProcessImage {
  readonly executable: string;
  readonly argv: string[];
  readonly env: string[];
}

async function imageOf(launcher: Launcher, pid: number): Promise<ProcessImage> {
  if (process.platform === "linux") {
    return {
      executable: await fs.promises.readlink(`/proc/${pid}/exe`),
      argv: (await fs.promises.readFile(`/proc/${pid}/cmdline`, "utf8"))
        .split("\0")
        .slice(0, -1),
      env: (await fs.promises.readFile(`/proc/${pid}/environ`, "utf8"))
        .split("\0")
        .slice(0, -1),
    };
  }
  const out = ran(
    `reading process ${pid}'s arguments`,
    await launcher.launch({
      bin: "python3",
      args: ["-c", PROCARGS2, String(pid)],
      timeoutMs: 5000,
      category: "lane.process",
    }),
  );
  return JSON.parse(out) as ProcessImage;
}

// One `ps` over the process table, off the daemon's loop.
async function ps(
  launcher: Launcher,
  what: string,
  args: string[],
): Promise<string> {
  return ran(
    what,
    await launcher.launch({
      bin: "ps",
      args,
      timeoutMs: 2000,
      category: "lane.process",
    }),
  );
}

// [LAW:one-source-of-truth] A pane as tmux and the terminal report it: its
// first process, the directory of the job that holds its terminal, and that
// job — the process group its terminal hands input to, whose leader is the
// program the shell started (every process on a terminal answers the same).
async function paneForeground(
  launcher: Launcher,
  hint: TmuxHint,
): Promise<{
  readonly panePid: number;
  readonly cwd: string;
  readonly foreground: number;
}> {
  const display = await runTmuxAsync(launcher, hint, "lane.tmux", [
    "display",
    "-p",
    "-t",
    hint.pane,
    "#{pane_pid}\t#{pane_current_path}",
  ]);
  if (display.kind !== "ok") throw new Error(display.reason);
  const [panePid = "", cwd = ""] = display.stdout.trimEnd().split("\t");
  const foreground = (
    await ps(launcher, `asking pane ${hint.pane}'s foreground job`, [
      "-o",
      "tpgid=",
      "-p",
      panePid,
    ])
  ).trim();
  return { panePid: Number(panePid), cwd, foreground: Number(foreground) };
}

async function paneClaude(
  launcher: Launcher,
  hint: TmuxHint,
): Promise<PaneClaude> {
  const {
    panePid,
    cwd,
    foreground: pid,
  } = await paneForeground(launcher, hint);
  const table = await ps(launcher, "listing processes", [
    "-A",
    "-o",
    "pid=,ppid=,args=",
  ]);
  const image = await imageOf(launcher, pid);
  const parent = processTable(table).get(pid)?.ppid;
  if (parent === undefined) {
    throw new Error(`pane ${hint.pane}'s foreground job ${pid} is gone`);
  }
  return {
    pid,
    // The installed binary itself, as cc-extra's own `bin/cc-attach` hands it
    // to the launcher (`readlink -f`): `~/.local/bin/claude` is a link to the
    // release it runs.
    executable: await fs.promises.realpath(image.executable),
    argv: image.argv,
    env: image.env,
    cwd,
    parent,
    fromShell: pid !== panePid,
    attached: runsAttached(table, pid, panePid),
  };
}

// How often the wait for a lane's subscriber looks again.
const FOLLOW_POLL_MS = 200;

// `following` is the daemon's FrameFeeds' answer: the lanes whose subscribers
// follow a session's frames now. `closing` ends what is no launch, as the
// daemon's launcher ends what is: a poll's wait, and the one signal sent
// directly.
export function productionLaneEdge(
  launcher: Launcher,
  following: (sessionId: string) => ReadonlySet<Lane>,
  closing: AbortSignal,
): LaneEdge {
  const wait = (ms: number): Promise<void> =>
    sleep(ms, undefined, { signal: closing });
  return {
    claudeInput: productionClaudeInputEdge(launcher),
    barPanes: async (hint) =>
      taggedBarPanes(
        await tmux(launcher, hint, [
          "list-panes",
          "-a",
          "-F",
          PANE_TAGS_FORMAT,
        ]),
        hint.pane,
      ),
    // Two or more words after the options are run as they are, with no shell
    // between (tmux ≥ 3.0), so no path in `argv` needs quoting for one.
    openBarPane: async (hint, argv, env) => {
      const split = await tmux(launcher, hint, [
        "split-window",
        "-d",
        "-v",
        "-l",
        "1",
        "-t",
        hint.pane,
        "-P",
        "-F",
        "#{pane_id}",
        ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        ...argv,
      ]);
      const opened = split.trim();
      await tmux(launcher, hint, [
        "set-option",
        "-p",
        "-t",
        opened,
        BAR_PANE_OPTION,
        hint.pane,
      ]);
      return opened;
    },
    closePane: async (hint, pane) =>
      void (await tmux(launcher, hint, ["kill-pane", "-t", pane])),
    // [LAW:single-enforcer] The session's process environment: the
    // session's facts, never those of whichever shell spawned this detached
    // daemon.
    claude: async (args, session) =>
      void ran(
        `claude ${args.join(" ")}`,
        await launcher.launch({
          bin: "claude",
          args: [...args],
          env: sessionEnv(process.env, session),
          timeoutMs: 30_000,
          category: "lane.claude",
        }),
      ),
    fileExists: (file) => fs.existsSync(file),
    presence,
    paneClaude: (hint) => paneClaude(launcher, hint),
    // [LAW:no-ambient-temporal-coupling] The pane's directory is the
    // shell's once the shell holds its terminal again: until it has reaped
    // Claude Code and taken the foreground back, tmux reads the directory of
    // the job that held it, or none. An interactive shell leads its own
    // process group, so it holds the terminal when it is the foreground job
    // — the shell that started Claude Code, which may itself be a job of the
    // pane's first shell (`nix develop`, a nested `bash`).
    paneDir: async (hint, shell) => {
      const until = Date.now() + SHELL_PATIENCE_MS;
      for (;;) {
        const pane = await paneForeground(launcher, hint);
        if (pane.foreground === shell) {
          // tmux prints an empty path when it cannot read the shell's
          // directory.
          if (pane.cwd === "") {
            throw new Error(`tmux read no directory for pane ${hint.pane}`);
          }
          return pane.cwd;
        }
        if (Date.now() > until) {
          throw new Error(
            `the shell in pane ${hint.pane} (pid ${shell}) did not take its terminal back within ${SHELL_PATIENCE_MS / 1000} s`,
          );
        }
        await wait(EXIT_POLL_MS);
      }
    },
    launcherNode: (pathVariable) =>
      launcherNode(
        pathVariable,
        (f) => regularFileWith(f, fs.constants.X_OK),
        canonical,
      ),
    onPath: (name, pathVariable) => {
      const file = executableOn(name, pathVariable, (f) =>
        regularFileWith(f, fs.constants.X_OK),
      );
      return file === null ? null : fs.realpathSync(file);
    },
    followed: async (sessionId, lane, withinMs) => {
      const until = Date.now() + withinMs;
      while (!following(sessionId).has(lane)) {
        if (Date.now() > until) return false;
        await wait(FOLLOW_POLL_MS);
      }
      return true;
    },
    // In a child: the reader holds the whole binary (~200 MB) in memory.
    moduleGraph: async (node, reader, executable) => {
      const result = await launcher.launch({
        bin: node,
        args: [reader, executable],
        timeoutMs: 20_000,
        category: "lane.process",
      });
      const refused =
        !result.ok && result.reason === "non-zero"
          ? refusalOf(result.stdout)
          : null;
      if (refused !== null) return { ok: false, reason: refused };
      // Anything else is the reader failing, not answering.
      ran(`reading ${executable}'s module graph`, result);
      return { ok: true };
    },
    // [LAW:no-silent-failure] A kill the OS refuses says which process it was
    // sent to, not a bare `kill ESRCH`.
    terminate: (pid) => {
      closing.throwIfAborted();
      try {
        process.kill(pid, "SIGTERM");
      } catch (err) {
        throw new Error(
          `Claude Code (pid ${pid}) could not be sent SIGTERM: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    exited: async (pid, withinMs) => {
      const until = Date.now() + withinMs;
      while (pidAlive(pid)) {
        if (Date.now() > until) return false;
        await wait(EXIT_POLL_MS);
      }
      return true;
    },
    // Typed as a slash command is, but with no ctrl+s first: in a shell that
    // stops the terminal's output.
    typeShellLine: async (hint, line) =>
      void (await tmux(
        launcher,
        hint,
        pasteLineArgs(hint.pane, SHELL_BUFFER, []),
        line,
      )),
  };
}
