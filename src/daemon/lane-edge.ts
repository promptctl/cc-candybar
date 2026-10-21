// The effects a lane's setup performs (src/daemon/lane-setup.ts): tmux calls
// against the session's recorded server, the `claude` CLI, the process table,
// and the relaunch script. What a click waits on is synchronous — a tmux call
// answers in milliseconds — and what outlasts a click's 200 ms budget (the
// `claude` CLI, the process table, the wait for an exit) runs off the
// daemon's loop.
//
// [LAW:single-enforcer] Every spawn goes through src/proc/launch (tmux through
// src/proc/tmux), under its own launch category.

import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { launch, type LaunchResult } from "../proc/launch.js";
import { runTmux, runTmuxAsync } from "../proc/tmux.js";
import type { TmuxHint } from "../tmux-hint.js";
import { productionClaudeInputEdge } from "../claude-input/edge.js";
import {
  BAR_PANE_OPTION,
  type LaneEdge,
  type PaneClaude,
} from "./lane-setup.js";

const THEN = ";";
const SHELL_BUFFER = "cc-candybar-lane";
// How often the wait for an exit looks again.
const EXIT_POLL_MS = 100;

function tmux(hint: TmuxHint, args: string[], stdinInput?: string): string {
  const run = runTmux(hint, "lane.tmux", args, stdinInput);
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

// The words a cc-extra attach launcher runs under (`bin/cc-attach`, which runs
// `src/bun-attach.js`).
const ATTACH = /(^|\/)(cc-attach|bun-attach\.js)(\s|$)/;

// [LAW:effects-at-boundaries] Pure over `ps -A -o pid=,ppid=,args=`: whether
// `pid`, or a process it descends from below the pane's own first process,
// is a cc-extra attach launcher.
export function runsAttached(
  table: string,
  pid: number,
  panePid: number,
): boolean {
  const procs = new Map<number, { ppid: number; args: string }>();
  for (const line of table.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m !== null)
      procs.set(Number(m[1]), { ppid: Number(m[2]), args: m[3]! });
  }
  const seen = new Set<number>();
  for (let p = pid; p !== panePid && !seen.has(p); ) {
    seen.add(p);
    const proc = procs.get(p);
    if (proc === undefined) return false;
    if (proc.args.split(" ").some((word) => ATTACH.test(word))) return true;
    p = proc.ppid;
  }
  return false;
}

// The exact argv a process was started with — `ps` joins it with spaces,
// which a value holding a space would make ambiguous. Linux keeps it in
// /proc; macOS answers it through sysctl's KERN_PROCARGS2 (argc, then the
// executable path, padding, then argv, each NUL-terminated), read here with
// python3's ctypes since node has no sysctl.
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
  "rest = rest[rest.index(b'\\0'):].lstrip(b'\\0')",
  "print(json.dumps([a.decode('utf-8', 'surrogateescape') for a in rest.split(b'\\0')[:argc]]))",
].join("\n");

async function argvOf(pid: number): Promise<string[]> {
  if (process.platform === "linux") {
    return (await fs.promises.readFile(`/proc/${pid}/cmdline`, "utf8"))
      .split("\0")
      .slice(0, -1);
  }
  const out = ran(
    `reading process ${pid}'s arguments`,
    await launch({
      bin: "python3",
      args: ["-c", PROCARGS2, String(pid)],
      timeoutMs: 5000,
      category: "lane.process",
    }),
  );
  return JSON.parse(out) as string[];
}

// One `ps` over the process table, off the daemon's loop.
async function ps(what: string, args: string[]): Promise<string> {
  return ran(
    what,
    await launch({
      bin: "ps",
      args,
      timeoutMs: 2000,
      category: "lane.process",
    }),
  );
}

async function paneClaude(hint: TmuxHint): Promise<PaneClaude> {
  const display = await runTmuxAsync(hint, "lane.tmux", [
    "display",
    "-p",
    "-t",
    hint.pane,
    "#{pane_pid}\t#{pane_current_path}",
  ]);
  if (display.kind !== "ok") throw new Error(display.reason);
  const [panePid = "", cwd = ""] = display.stdout.trimEnd().split("\t");
  // The pane's foreground job: the process group its terminal hands input to,
  // whose leader is the program the shell started.
  const pid = Number(
    (
      await ps(`asking pane ${hint.pane}'s foreground job`, [
        "-o",
        "tpgid=",
        "-p",
        panePid,
      ])
    ).trim(),
  );
  const table = await ps("listing processes", ["-A", "-o", "pid=,ppid=,args="]);
  return {
    pid,
    argv: await argvOf(pid),
    cwd,
    fromShell: String(pid) !== panePid,
    attached: runsAttached(table, pid, Number(panePid)),
  };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it runs, as someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export function productionLaneEdge(scriptDir: string): LaneEdge {
  return {
    claudeInput: productionClaudeInputEdge(),
    barPanes: (hint) =>
      taggedBarPanes(
        tmux(hint, ["list-panes", "-a", "-F", PANE_TAGS_FORMAT]),
        hint.pane,
      ),
    // Two or more words after the options are run as they are, with no shell
    // between (tmux ≥ 3.0), so no path in `argv` needs quoting for one.
    openBarPane: (hint, argv, env) => {
      const opened = tmux(hint, [
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
      ]).trim();
      tmux(hint, [
        "set-option",
        "-p",
        "-t",
        opened,
        BAR_PANE_OPTION,
        hint.pane,
      ]);
      return opened;
    },
    closePane: (hint, pane) => void tmux(hint, ["kill-pane", "-t", pane]),
    claude: async (args, claudeConfigDir) =>
      void ran(
        `claude ${args.join(" ")}`,
        await launch({
          bin: "claude",
          args: [...args],
          env:
            claudeConfigDir === undefined
              ? process.env
              : { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir },
          timeoutMs: 30_000,
          category: "lane.claude",
        }),
      ),
    fileExists: (file) => fs.existsSync(file),
    paneClaude,
    // The daemon's own socket directory: this user's alone (mode 0700, which
    // the daemon checks before it binds — src/daemon/paths.ts).
    writeScript: (name, text) => {
      const file = path.join(scriptDir, name);
      fs.writeFileSync(file, text(file), { mode: 0o700 });
      return file;
    },
    exited: async (pid, withinMs) => {
      const until = Date.now() + withinMs;
      while (alive(pid)) {
        if (Date.now() > until) return false;
        await sleep(EXIT_POLL_MS);
      }
      return true;
    },
    // A bracketed paste then Enter, as a slash command is typed, but with no
    // ctrl+s first: in a shell that stops the terminal's output.
    typeShellLine: (hint, line) =>
      void tmux(
        hint,
        [
          "load-buffer",
          "-b",
          SHELL_BUFFER,
          "-",
          THEN,
          "paste-buffer",
          "-p",
          "-d",
          "-b",
          SHELL_BUFFER,
          "-t",
          hint.pane,
          THEN,
          "send-keys",
          "-t",
          hint.pane,
          "Enter",
        ],
        line,
      ),
  };
}
