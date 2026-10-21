// What turning an animation lane on or off takes beyond the daemon's own gate
// (src/config/lanes.ts): a lane's toggle writes its switch, and the daemon's
// FrameFeeds admit or refuse its subscriber by it, but each lane's subscriber
// has to be RUNNING to subscribe, and none of them starts itself:
//
//   A, band       — the candybar-band mod (`<checkout>/mod`), loaded by Claude
//                   Code: installed from the checkout's own marketplace, read
//                   in place, then `/reload-plugins` loads it into the session.
//   B, statusline — Claude Code started under cc-extra's attach launcher,
//                   which ships beside the bundle (src/attach-launcher.ts) and
//                   whose `statusline-push` seam feeds the statusline the
//                   daemon's frames. It attaches only at process start
//                   (cc-extra's SEAMS.md: JSC gives debug hooks only to code
//                   compiled while a debugger is attached), so the session's
//                   Claude Code is exited and started again under it, resuming
//                   the session.
//   C, pane       — `cc-candybar bar-pane <pane>`, in a tmux pane split under
//                   the session's.
//
// [LAW:effects-at-boundaries] Each lane's setup is a plan over `LaneEdge`, the
// record holding every effect (tmux, the `claude` CLI, the process table, the
// pane's prompt), so a test drives every plan with fakes. A refusal is the
// user's to act on, thrown as BadVerbArgs with what to do, and the click shows
// it (src/daemon/click-error.ts).

import path from "node:path";
import {
  LANES,
  LANE_NAMES,
  type Lane,
  type LaneSwitches,
} from "../config/lanes.js";
import { holdClickError } from "./click-error.js";
import type { SessionStateRW } from "./session-state.js";
import type { Instant } from "../utils/instant.js";
import type { ClientHints } from "./protocol.js";
import type { RenderOrigin } from "./verbs/index.js";
import type { TmuxHint } from "../tmux-hint.js";
import {
  tmuxPaneOf,
  typeSlash,
  type ClaudeInputEdge,
} from "../claude-input/edge.js";
import { slashLine } from "../claude-input/slash-line.js";
import { draftShown, turnRunning } from "../claude-input/prompt-screen.js";
import { relaunchOf } from "./claude-relaunch.js";
import { sourceCheckoutOf } from "./build-currency.js";
import { attachLauncherOf, moduleGraphReaderOf } from "../attach-launcher.js";
import { BadVerbArgs } from "./verb-error.js";
import { shellWord } from "../shell-word.js";

// The band mod, as the checkout's marketplace (`.claude-plugin/
// marketplace.json`) names it.
export const BAND_PLUGIN = "candybar-band@cc-candybar";
// The native client the band mod starts, beside its folder (mod/README.md).
const BAND_CLIENT = path.join("bin", "cc-candybar-native");
// The tmux pane option naming, on a bar pane the daemon opened, the pane whose
// bar it draws: how the daemon finds its bar panes again to close them.
export const BAR_PANE_OPTION = "@cc-candybar-bar-pane";
// How long the session's Claude Code has to exit after SIGTERM before the
// restart under the attach launcher is given up on.
export const EXIT_PATIENCE_MS = 15_000;
// How long the restarted Claude Code has to resume its session and have its
// statusline, under the attach launcher, subscribe to lane B (measured ~6 s).
export const ATTACH_PATIENCE_MS = 30_000;

const RELOAD_PLUGINS = slashLine("/reload-plugins");

// The Claude Code a session's pane shows: the pane's foreground process, the
// executable it runs (what a restart runs again, with no PATH between),
// whether the pane's own first process is a shell it was started from (so a
// restart has somewhere to run), whether it already runs under the attach
// launcher, the environment it was started with, and the directory it runs
// in.
export interface PaneClaude {
  readonly pid: number;
  readonly executable: string;
  readonly argv: readonly string[];
  // The environment it was started with, `NAME=value` each.
  readonly env: readonly string[];
  readonly cwd: string;
  readonly fromShell: boolean;
  readonly attached: boolean;
}

export interface LaneEdge {
  readonly claudeInput: ClaudeInputEdge;
  // The bar panes the daemon opened for `tmux.pane`.
  readonly barPanes: (tmux: TmuxHint) => readonly string[];
  // Split a pane under `tmux.pane` running `argv` with `env`, tagged as its
  // bar pane; answers the new pane's id.
  readonly openBarPane: (
    tmux: TmuxHint,
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
  ) => string;
  readonly closePane: (tmux: TmuxHint, pane: string) => void;
  // Run the `claude` CLI under the session's Claude Code directory; rejects
  // with its own words when it fails.
  readonly claude: (
    args: readonly string[],
    claudeConfigDir: string | undefined,
  ) => Promise<void>;
  readonly fileExists: (file: string) => boolean;
  readonly paneClaude: (tmux: TmuxHint) => Promise<PaneClaude>;
  // Write a script only this user can read; answers its path.
  readonly writeScript: (name: string, text: string) => string;
  readonly removeScript: (file: string) => void;
  // Whether `executable` embeds a module graph the attach launcher can run,
  // as the launcher's own reader (`reader`, run by `node`) answers it.
  readonly moduleGraph: (
    node: string,
    reader: string,
    executable: string,
  ) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: string }
  >;
  // Send `pid` SIGTERM.
  readonly terminate: (pid: number) => void;
  // Resolves true once `pid` has exited, false if it is still running after
  // `withinMs`.
  readonly exited: (pid: number, withinMs: number) => Promise<boolean>;
  // Type `line` into the pane's shell and run it.
  readonly typeShellLine: (tmux: TmuxHint, line: string) => void;
  // Resolves true once a subscriber of `lane` follows `sessionId`'s frames,
  // false if none does within `withinMs`.
  readonly followed: (
    sessionId: string,
    lane: Lane,
    withinMs: number,
  ) => Promise<boolean>;
}

// This daemon: the bundle it runs, how node runs it, and its socket — what a
// bar pane runs to follow this daemon's frames, and what the attach launcher
// beside the bundle runs under.
export interface LaneHost {
  readonly bundle: string;
  readonly node: readonly string[];
  readonly socket: string;
}

export interface LaneSession {
  readonly sessionId: string;
  readonly hints: ClientHints;
  // The inputs its last render resolved its config from.
  readonly origin: RenderOrigin;
  // Its conversation, as Claude Code names it in the statusline JSON: a
  // session resumes from it, and has none until its first message.
  readonly transcript: string;
}

// [LAW:types-are-the-program] What a lane's setup came to: finished in the
// click, or a part still running once the click is answered — B's restart
// waits for Claude Code to exit — whose own outcome lands later.
export type LaneOutcome =
  | { readonly kind: "done"; readonly said: string }
  | {
      readonly kind: "underway";
      readonly said: string;
      readonly finished: Promise<string>;
    };

type Plan = (
  session: LaneSession,
  host: LaneHost,
  edge: LaneEdge,
) => LaneOutcome;

const done = (said: string): LaneOutcome => ({ kind: "done", said });

function paneOf(session: LaneSession): TmuxHint {
  const pane = tmuxPaneOf(session.hints.tmux);
  if (pane.kind === "refused") throw new BadVerbArgs(pane.reason);
  return pane.hint;
}

// [LAW:one-source-of-truth] THE table: every lane's setup, keyed by LANES, so
// a lane added there is a compile error here until it says what turning it on
// and off takes.
export const LANE_SETUP: Readonly<Record<Lane, { on: Plan; off: Plan }>> = {
  band: {
    on: (session, host, edge) => {
      const checkout = sourceCheckoutOf(host.bundle);
      if (checkout === null) {
        throw new BadVerbArgs(
          `${LANES.band.label} runs the band mod from a cc-candybar source checkout, and this daemon runs ${host.bundle} — run the daemon from a checkout (mod/README.md)`,
        );
      }
      const client = path.join(checkout, BAND_CLIENT);
      if (!edge.fileExists(client)) {
        throw new BadVerbArgs(
          `the band mod starts ${client}, which is not built — run \`just install-rust\` in ${checkout}`,
        );
      }
      return {
        kind: "underway",
        said: `installing ${BAND_PLUGIN} from ${checkout}`,
        finished: installBand(session, checkout, edge),
      };
    },
    // The installed mod draws nothing while the lane is off: the daemon
    // refuses its subscriber, and it hands the band on.
    off: () =>
      done("nothing to stop: the band mod draws nothing while the lane is off"),
  },
  statusline: {
    on: (session, host, edge) => {
      const tmux = paneOf(session);
      const launcher = attachLauncherOf(host.bundle);
      if (!edge.fileExists(launcher)) {
        throw new BadVerbArgs(
          `${LANES.statusline.label} restarts Claude Code under the attach launcher, which is not at ${launcher} beside this daemon's bundle — rebuild (\`pnpm build\`) or reinstall cc-candybar`,
        );
      }
      // [LAW:no-silent-failure] `--resume` of a session with no transcript
      // finds no conversation, and the pane is left at its shell.
      if (!edge.fileExists(session.transcript)) {
        throw new BadVerbArgs(
          `this session has no conversation to resume yet — send a first message, then turn ${LANES.statusline.label} off and on again`,
        );
      }
      return {
        kind: "underway",
        said: `restarting Claude Code in ${tmux.pane} under the attach launcher`,
        finished: restartUnderAttach(
          session,
          tmux,
          [host.node[0]!, launcher],
          edge,
        ),
      };
    },
    // Lane off, the attached statusline is refused frames and shows its
    // command's output, as a stock one does.
    off: () =>
      done(
        "nothing to stop: the attached statusline draws its command's output while the lane is off",
      ),
  },
  pane: {
    on: (session, host, edge) => {
      const tmux = paneOf(session);
      const open = edge.barPanes(tmux);
      if (open.length > 0) {
        return done(
          `bar pane ${open.join(", ")} already draws ${tmux.pane}'s bar`,
        );
      }
      const opened = edge.openBarPane(
        tmux,
        [...host.node, host.bundle, "bar-pane", tmux.pane],
        { CC_CANDYBAR_SOCKET: host.socket },
      );
      return done(`opened bar pane ${opened} under ${tmux.pane}`);
    },
    // Off is "no bar pane draws this session's bar", which a session with no
    // tmux pane already is.
    off: (session, _host, edge) => {
      const pane = tmuxPaneOf(session.hints.tmux);
      if (pane.kind === "refused") {
        return done(`no bar pane to close: ${pane.reason}`);
      }
      const tmux = pane.hint;
      const open = edge.barPanes(tmux);
      for (const pane of open) edge.closePane(tmux, pane);
      return done(
        open.length === 0
          ? `no bar pane draws ${tmux.pane}'s bar`
          : `closed bar pane ${open.join(", ")}`,
      );
    },
  },
};

// [LAW:no-ambient-temporal-coupling] The `claude` CLI takes most of a second,
// so the install runs off the daemon's loop, after the click is answered.
async function installBand(
  session: LaneSession,
  checkout: string,
  edge: LaneEdge,
): Promise<string> {
  const dir = session.hints.claudeConfigDir;
  await edge.claude(["plugin", "marketplace", "add", checkout], dir);
  await edge.claude(["plugin", "install", BAND_PLUGIN], dir);
  const typed = typeSlash(edge.claudeInput, session.hints.tmux, RELOAD_PLUGINS);
  if (typed.kind === "refused") {
    throw new Error(
      `the band mod is installed, but /reload-plugins was not typed: ${typed.reason} — or type /reload-plugins yourself`,
    );
  }
  return `installed ${BAND_PLUGIN} from ${checkout} and typed /reload-plugins into ${typed.pane}`;
}

// Exit the pane's Claude Code and start it again under the attach launcher
// (`launcher`: node and the launcher's script), resuming the session — off the
// daemon's loop: reading the process table and waiting for the exit outlast a
// click.
async function restartUnderAttach(
  session: LaneSession,
  tmux: TmuxHint,
  launcher: readonly [node: string, script: string],
  edge: LaneEdge,
): Promise<string> {
  const claude = await edge.paneClaude(tmux);
  if (claude.attached) {
    return `left Claude Code in ${tmux.pane} running: it already runs under the attach launcher`;
  }
  // [LAW:no-silent-failure] The restart ends Claude Code, and a turn in
  // progress with it.
  if (turnRunning(edge.claudeInput.read(tmux))) {
    throw new Error(
      `Claude Code in ${tmux.pane} is in the middle of a turn, and restarting it under the attach launcher would end that turn — once it is idle, turn ${LANES.statusline.label} off and on again`,
    );
  }
  // [LAW:no-silent-failure] A draft lives only as long as the Claude Code
  // holding it: the restart would end it with the draft.
  if (draftShown(edge.claudeInput.read(tmux))) {
    throw new Error(
      `the prompt in ${tmux.pane} holds a draft, which restarting Claude Code under the attach launcher would lose — send or clear it, then turn ${LANES.statusline.label} off and on again`,
    );
  }
  if (!claude.fromShell) {
    throw new Error(
      `Claude Code is the first process of pane ${tmux.pane}, so nothing would be left in the pane to start it again under the attach launcher — start Claude Code from a shell in the pane`,
    );
  }
  const relaunch = relaunchOf(claude, session.sessionId);
  if (relaunch.kind === "refused") {
    throw new Error(`${relaunch.reason} — restart it with that flag removed`);
  }
  // [LAW:no-silent-failure] The launcher runs the module graph a Bun-compiled
  // Claude Code embeds; one installed from npm runs under node, embeds none,
  // and once exited could not be started again under the launcher.
  const [node, launcherScript] = launcher;
  const graph = await edge.moduleGraph(
    node,
    moduleGraphReaderOf(launcherScript),
    claude.executable,
  );
  if (!graph.ok) {
    throw new Error(
      `Claude Code in ${tmux.pane} runs ${claude.executable}, which the attach launcher cannot start (${graph.reason}) — ${LANES.statusline.label} needs the native Claude Code install (\`claude install\`), so it was left running`,
    );
  }
  const script = edge.writeScript(
    `relaunch-${session.sessionId}.sh`,
    relaunchScript(
      relaunch.dir,
      [...launcher, claude.executable, ...relaunch.args],
      claude.env,
    ),
  );
  // [LAW:effects-at-boundaries] The script's whole life is this restart: it
  // is gone once the restart is decided, however that went.
  try {
    // SIGTERM, not `/exit`: Claude Code exits on it as on `/exit`, printing
    // its resume line, but `/exit` in a session started with `--worktree`
    // removes the worktree when it holds no changes (the script would then
    // start in a directory that is gone) and asks whether to keep it when it
    // does (the restart would wait on that dialog). SIGTERM leaves the
    // worktree as it is (measured on 2.1.289).
    edge.terminate(claude.pid);
    if (!(await edge.exited(claude.pid, EXIT_PATIENCE_MS))) {
      throw new Error(
        `Claude Code in ${tmux.pane} did not exit within ${EXIT_PATIENCE_MS / 1000} s of SIGTERM, so it was not restarted under the attach launcher`,
      );
    }
    edge.typeShellLine(tmux, `sh ${shellWord(script)}`);
    // [LAW:no-silent-failure] Typed is not restarted: the restart happened
    // when the session's statusline, under the launcher, subscribes to lane
    // B. The launcher starts nothing in place of an attach it could not make
    // and says why in the pane.
    if (
      !(await edge.followed(
        session.sessionId,
        "statusline",
        ATTACH_PATIENCE_MS,
      ))
    ) {
      throw new Error(
        `Claude Code in ${tmux.pane} did not come back attached within ${ATTACH_PATIENCE_MS / 1000} s of its restart — the pane says why`,
      );
    }
  } finally {
    edge.removeScript(script);
  }
  return `restarted Claude Code in ${tmux.pane} under the attach launcher from ${relaunch.dir}, resuming ${session.sessionId}, and its statusline follows lane B`;
}

// How many sessions' last reports LaneSetups keeps.
const MAX_SESSIONS_SEEN = 1024;
// A session this daemon has not seen: no lane running, no setting moved.
const UNSEEN = {
  switches: Object.fromEntries(
    LANE_NAMES.map((lane) => [lane, false]),
  ) as LaneSwitches,
  revision: 0,
};

// [LAW:single-enforcer] The one owner of lane setup. What a lane runs follows
// its switch as the session's renders resolve it, whatever in the session
// moved the switch — the menu's toggle, its ↺, ↶ undo, a preset picked — so no
// control carries the setup itself (review of brandon-menus-sjhy.amf). Every
// render reports the switches it drew by and the revision of the session's own
// setting moves (SettingsHistory.revision — a reset that only deletes the
// file's value moves it, a render rewriting the session's client hints does
// not); a lane whose switch differs from the session's previous report is
// brought in line, off the render, when the session's own moves moved with it.
// A switch moved only by the config file — another session's save, a hand
// edit — changes what every session reading that file renders by, and setting
// up a lane in each of them would restart every idle Claude Code on the
// machine for one session's save: such a session's lanes are brought in line
// with its switches at its own next setting move, whichever setting it moves.
// A session this daemon has not seen runs no lane as far as it knows, at
// revision 0: its first report sets up the lanes switched on only when it has
// already moved a setting here (a toggle clicked on a bar the daemon before a
// restart drew), so a daemon restart re-runs no setup of its own accord. One
// session's setups run one at a time, each after the last has finished — two
// restarts of one pane would type over each other. How each setup ends is
// logged, and a failure is held on the bar as a click's failure is
// (src/daemon/click-error.ts).
export class LaneSetups {
  private readonly seen = new Map<
    string,
    { readonly switches: LaneSwitches; readonly revision: number }
  >();
  // Each session's setups still to run, while one runs.
  private readonly queued = new Map<string, Array<() => Promise<void>>>();

  constructor(
    private readonly deps: {
      readonly edge: LaneEdge;
      readonly host: LaneHost;
      readonly state: SessionStateRW;
      readonly log: (level: "info" | "warn", msg: string) => void;
      readonly now: () => Instant;
      // [LAW:effects-at-boundaries] Runs a setup after the render that saw
      // its switch move has returned: a render writes no session state.
      readonly defer: (run: () => void) => void;
    },
  ) {}

  // The switches a render of `session` drew by, at `revision` of its own
  // setting moves.
  observe(
    session: LaneSession,
    switches: LaneSwitches,
    revision: number,
  ): void {
    const before = this.seen.get(session.sessionId) ?? UNSEEN;
    // [LAW:carrying-cost] Bounded like the daemon's other per-session
    // memories: least recently rendered forgotten first.
    this.seen.delete(session.sessionId);
    this.seen.set(session.sessionId, { switches, revision });
    for (const [oldest] of this.seen) {
      if (this.seen.size <= MAX_SESSIONS_SEEN) break;
      this.seen.delete(oldest);
    }
    if (before.revision === revision) return;
    for (const lane of LANE_NAMES) {
      if (before.switches[lane] === switches[lane]) continue;
      const on = switches[lane];
      this.deps.defer(() =>
        this.enqueue(session.sessionId, () => this.sync(session, lane, on)),
      );
    }
  }

  // [LAW:no-ambient-temporal-coupling] Runs `setup` now when none of the
  // session's runs, else after the ones queued before it.
  private enqueue(sessionId: string, setup: () => Promise<void>): void {
    const queue = this.queued.get(sessionId);
    if (queue !== undefined) {
      queue.push(setup);
      return;
    }
    const waiting: Array<() => Promise<void>> = [];
    this.queued.set(sessionId, waiting);
    const run = (next: () => Promise<void>): void =>
      void next().then(() => {
        const after = waiting.shift();
        if (after === undefined) this.queued.delete(sessionId);
        else run(after);
      });
    run(setup);
  }

  // Resolves once the setup has finished, however it ended.
  private sync(session: LaneSession, lane: Lane, on: boolean): Promise<void> {
    const where = `(session=${session.sessionId})`;
    const failed = (error: unknown): void => {
      const text = `lane: ${lane} ${on ? "on" : "off"}: ${error instanceof Error ? error.message : String(error)}`;
      this.deps.log("warn", `${text} ${where}`);
      holdClickError(this.deps.state, session.sessionId, text, this.deps.now());
    };
    let outcome: LaneOutcome;
    try {
      outcome = LANE_SETUP[lane][on ? "on" : "off"](
        session,
        this.deps.host,
        this.deps.edge,
      );
    } catch (error) {
      failed(error);
      return Promise.resolve();
    }
    this.deps.log(
      "info",
      `lane: ${lane} ${on ? "on" : "off"} — ${outcome.said} ${where}`,
    );
    if (outcome.kind === "underway") {
      return outcome.finished.then(
        (finished) =>
          this.deps.log("info", `lane: ${lane} ${finished} ${where}`),
        failed,
      );
    }
    return Promise.resolve();
  }
}

// A variable `sh` can export: one whose name is an identifier. The others an
// environment can carry (bash's exported functions, `BASH_FUNC_f%%`) are its
// own, and the shell a pane runs re-exports them itself.
const EXPORTABLE = /^[A-Za-z_][A-Za-z0-9_]*=/;

// [LAW:effects-at-boundaries] The script a shell runs to start the session
// again: `argv`, every word an absolute path or an argument, and nothing else
// the shell would look up — `cd`, `unset`, `export` and `exec` are its own.
// It is typed as `sh <script>`, a line every shell reads alike, so no quoting
// has to survive the user's shell (fish quotes differently from sh). It runs
// `argv` in the directory Claude Code ran in, under the environment Claude
// Code was started with (`env`, `NAME=value` each) — the variables it was
// started with set as they were (a `CC_CANDYBAR_CONFIG`, a model), and its
// Claude Code directory unset when it had none, so `--resume` looks where the
// session lives whatever the pane's shell exports.
export function relaunchScript(
  cwd: string,
  argv: readonly string[],
  env: readonly string[],
): string {
  const exported = env.filter((v) => EXPORTABLE.test(v));
  return [
    `cd -- ${shellWord(cwd)} || exit 1`,
    ...(exported.some((v) => v.startsWith("CLAUDE_CONFIG_DIR="))
      ? []
      : ["unset CLAUDE_CONFIG_DIR"]),
    ...exported.map((v) => {
      const eq = v.indexOf("=");
      return `export ${v.slice(0, eq)}=${shellWord(v.slice(eq + 1))}`;
    }),
    `exec ${argv.map(shellWord).join(" ")}`,
    "",
  ].join("\n");
}
