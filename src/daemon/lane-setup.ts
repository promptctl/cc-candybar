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
//                   Claude Code is exited and started again under it, on the
//                   same session.
//   C, pane       — `cc-candybar bar-pane <pane>`, in a tmux pane split under
//                   the session's.
//
// [LAW:effects-at-boundaries] Each lane's setup is a plan over `LaneEdge`, the
// record holding every effect (tmux, the `claude` CLI, the process table, the
// pane's prompt), so a test drives every plan with fakes. A refusal is the
// user's to act on, thrown as BadVerbArgs with what to do, and the click shows
// it (src/daemon/click-error.ts).

import path from "node:path";
import { CLAUDE_CONFIG_DIR_ENV } from "../claude-settings.js";
import { CONFIG_ENV } from "../config-hint.js";
import { MEMENTO_ENV_VARS } from "../memento-hint.js";
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
import {
  draftShown,
  promptState,
  turnRunning,
  type PaneSnapshot,
  type PromptState,
} from "../claude-input/prompt-screen.js";
import {
  relaunchArgs,
  sessionArgs,
  startPlace,
  type SessionStart,
} from "./claude-relaunch.js";
import type { Answered } from "./render-sightings.js";
import type { Presence } from "../utils/presence.js";
import { sourceCheckoutOf } from "./build-currency.js";
import {
  attachCommandLine,
  attachLauncherOf,
  moduleGraphReaderOf,
} from "../attach-launcher.js";
import { BadVerbArgs } from "./verb-error.js";

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
  readonly presence: (file: string) => Presence;
  readonly paneClaude: (tmux: TmuxHint) => Promise<PaneClaude>;
  // The directory the pane's shell is in: once the Claude Code it started
  // has exited, the directory Claude Code was started in.
  readonly paneDir: (tmux: TmuxHint) => Promise<string>;
  // The first executable named `name` on `pathVariable`, links resolved, or
  // null when there is none.
  readonly onPath: (
    name: string,
    pathVariable: string | undefined,
  ) => string | null;
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
  // Type `line` into the pane's shell and run it, as the user would: it
  // lands in the shell's history.
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
// bar pane runs to follow this daemon's frames — and the attach preload a
// restart starts Claude Code with, the one `--help` names
// (`stableAttachPreload`, src/install/index.ts), so the line a restart types
// still runs from the shell's history after an upgrade.
export interface LaneHost {
  readonly bundle: string;
  readonly node: readonly string[];
  readonly socket: string;
  readonly preload: string;
}

export interface LaneSession {
  readonly sessionId: string;
  readonly hints: ClientHints;
  // The inputs its last render resolved its config from.
  readonly origin: RenderOrigin;
  // Its conversation, as Claude Code names it in the statusline JSON: a
  // session resumes from it, and has none until its first message.
  readonly transcript: string;
  // Whether Claude Code has answered in it, by the one mark it leaves
  // (`answeredOf`): a session it has answered in has a conversation, whether
  // or not a transcript of it is on disk.
  readonly answered: Answered;
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
      // The preload starts the launcher beside itself (src/attach-preload.ts).
      const launcher = attachLauncherOf(host.preload);
      const missing = [host.preload, launcher].find(
        (file) => !edge.fileExists(file),
      );
      if (missing !== undefined) {
        throw new BadVerbArgs(
          `${LANES.statusline.label} restarts Claude Code under the attach launcher, and ${missing} is not there — run \`cc-candybar install\` (in a checkout, \`pnpm build\`)`,
        );
      }
      return {
        kind: "underway",
        said: `restarting Claude Code in ${tmux.pane} under the attach launcher`,
        finished: restartUnderAttach(
          session,
          tmux,
          { node: host.node[0]!, launcher, preload: host.preload },
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

// The attach launcher a restart starts Claude Code under: the preload the
// typed line names, the launcher it starts, and the node that reads the
// launcher's module graph check.
interface Attach {
  readonly node: string;
  readonly launcher: string;
  readonly preload: string;
}

// [LAW:one-source-of-truth] The variables the restart line sets as Claude
// Code was started with them: the ones the bar reads off a session's client
// — its Claude Code directory, which `--resume` also looks the session up
// under, its cc-candybar config, which decides whether lane B is on, and
// memento's config home. The rest of the environment is the shell's own,
// which the shell the line is typed into still exports, and the line lands
// in the shell's history, where a credential must never be written.
const CARRIED_ENV: ReadonlySet<string> = new Set([
  CLAUDE_CONFIG_DIR_ENV,
  CONFIG_ENV,
  ...MEMENTO_ENV_VARS,
]);

// Of `env` (`NAME=value` each), the variables the restart line sets.
function carriedEnv(
  env: readonly string[],
): ReadonlyArray<readonly [string, string]> {
  return env.flatMap((v) => {
    const at = v.indexOf("=");
    const name = v.slice(0, at);
    return at > 0 && CARRIED_ENV.has(name)
      ? [[name, v.slice(at + 1)] as const]
      : [];
  });
}

// The value `env` (`NAME=value` each) gives `name`.
function valueIn(env: readonly string[], name: string): string | undefined {
  return env.find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1);
}

// Exit the pane's Claude Code and start it again under the attach launcher,
// on the same session, by typing one line into the pane's shell — the line a
// user reruns from the shell's history — off the daemon's loop: reading the
// process table and waiting for the exit outlast a click.
async function restartUnderAttach(
  session: LaneSession,
  tmux: TmuxHint,
  attach: Attach,
  edge: LaneEdge,
): Promise<string> {
  const claude = await edge.paneClaude(tmux);
  if (claude.attached) {
    return `left Claude Code in ${tmux.pane} running: it already runs under the attach launcher`;
  }
  if (!claude.fromShell) {
    throw new Error(
      `Claude Code is the first process of pane ${tmux.pane}, so nothing would be left in the pane to start it again under the attach launcher — start Claude Code from a shell in the pane`,
    );
  }
  // [LAW:no-silent-failure] The launcher runs the module graph a Bun-compiled
  // Claude Code embeds; one installed from npm runs under node, embeds none,
  // and once exited could not be started again under the launcher.
  const graph = await edge.moduleGraph(
    attach.node,
    moduleGraphReaderOf(attach.launcher),
    claude.executable,
  );
  if (!graph.ok) {
    throw new Error(
      `Claude Code in ${tmux.pane} runs ${claude.executable}, which the attach launcher cannot start (${graph.reason}) — ${LANES.statusline.label} needs the native Claude Code install (\`claude install\`), so it was left running`,
    );
  }
  // [LAW:no-ambient-temporal-coupling] Whether ending Claude Code loses
  // anything is judged on the pane as it is at the kill, not as it was before
  // the module-graph read above (seconds, on a large binary): the user may
  // have started a turn or a draft meanwhile, or left Claude Code.
  const now = await edge.paneClaude(tmux);
  if (now.pid !== claude.pid) {
    throw new Error(
      `Claude Code in ${tmux.pane} is no longer the process the restart read (pid ${claude.pid}), so it was not restarted under the attach launcher`,
    );
  }
  const loses = endingLoses(edge.claudeInput.read(tmux));
  if (loses !== null) {
    throw new Error(
      `Claude Code in ${tmux.pane} was left running: ${loses} — then turn ${LANES.statusline.label} off and on again`,
    );
  }
  const unrestartable = conversationLost(
    session,
    edge.presence(session.transcript),
  );
  if (unrestartable !== null) {
    throw new Error(
      `Claude Code in ${tmux.pane} was left running: ${unrestartable}`,
    );
  }
  const carried = relaunchArgs(claude.argv);
  if (carried.kind === "refused") {
    throw new Error(`${carried.reason} — restart it with that flag removed`);
  }
  // The line names `claude` when the shell would find this same release by
  // that word: the release's own path is removed by Claude Code's next
  // update, and a rerun from history would then find nothing there.
  const program =
    edge.onPath("claude", valueIn(claude.env, "PATH")) === claude.executable
      ? "claude"
      : claude.executable;
  const env = carriedEnv(claude.env);
  const lineIn = (
    place: { readonly dir: string; readonly args: readonly string[] },
    start: SessionStart,
  ): string =>
    attachCommandLine(attach.preload, {
      dir: place.dir,
      env,
      program,
      args: [...place.args, ...carried.args, ...sessionArgs(start)],
    });
  // SIGTERM, not `/exit`: Claude Code exits on it as on `/exit`, printing
  // its resume line, but `/exit` in a session started with `--worktree`
  // removes the worktree when it holds no changes (the line would then
  // start in a directory that is gone) and asks whether to keep it when it
  // does (the restart would wait on that dialog). SIGTERM leaves the
  // worktree as it is (measured on 2.1.289).
  edge.terminate(claude.pid);
  if (!(await edge.exited(claude.pid, EXIT_PATIENCE_MS))) {
    throw new Error(
      `Claude Code in ${tmux.pane} did not exit within ${EXIT_PATIENCE_MS / 1000} s of SIGTERM, so it was not restarted under the attach launcher`,
    );
  }
  // [LAW:no-ambient-temporal-coupling] The line is composed once Claude Code
  // has exited. Whether the session has a conversation to resume is read when
  // nothing is left to write its transcript: a first message sent up to the
  // kill writes it, and a fresh start on its id would then be refused as in
  // use. And the pane's shell is its foreground again, so the pane's
  // directory is the shell's — where Claude Code was started, which a
  // relative path among its flags resolves against (measured: tmux's
  // `pane_current_path` is the foreground job's directory).
  // [LAW:no-silent-failure] Past the kill, a restart that stops leaves the
  // pane at its shell: what stopped it is said with the line that starts
  // Claude Code again on the session.
  const stranded = (why: string, line: string): Error =>
    new Error(
      `Claude Code in ${tmux.pane} exited, but ${why}, so it was not started again — start it with \`${line}\``,
    );
  const start = sessionStartOf(session, edge.presence(session.transcript));
  const chosen: SessionStart =
    start.kind === "unchecked"
      ? { kind: "resume", sessionId: session.sessionId }
      : start;
  let startDir: string;
  try {
    startDir = await edge.paneDir(tmux);
  } catch (e) {
    throw stranded(
      `the directory it was started in could not be read (${(e as Error).message})`,
      lineIn(startPlace(null, claude.cwd), chosen),
    );
  }
  const line = lineIn(startPlace(startDir, claude.cwd), chosen);
  if (start.kind === "unchecked") {
    throw stranded(
      `whether session ${session.sessionId} has a conversation could not be seen (${start.error})`,
      line,
    );
  }
  try {
    edge.typeShellLine(tmux, line);
  } catch (e) {
    throw stranded(
      `the line could not be typed into its pane (${(e as Error).message})`,
      line,
    );
  }
  // [LAW:no-silent-failure] Typed is not restarted: the restart happened when
  // the session's statusline, under the launcher, subscribes to lane B. The
  // launcher starts nothing in place of an attach it could not make and says
  // why in the pane.
  if (
    !(await edge.followed(session.sessionId, "statusline", ATTACH_PATIENCE_MS))
  ) {
    throw new Error(
      `Claude Code in ${tmux.pane} did not come back attached within ${ATTACH_PATIENCE_MS / 1000} s of \`${line}\` — the pane says why`,
    );
  }
  return `restarted Claude Code in ${tmux.pane} under the attach launcher with \`${line}\`, ${STARTED[start.kind](session.sessionId)}, and its statusline follows lane B`;
}

// [LAW:no-silent-failure] What a restart would lose of the session's
// conversation, or null when nothing, judged before the kill: a transcript
// stat could not see, or a conversation Claude Code has answered in (or
// does not say whether it has) with no transcript to resume it from — its
// persistence switched off — which a fresh start would throw away.
function conversationLost(
  session: LaneSession,
  transcript: Presence,
): string | null {
  if (typeof transcript === "object") {
    return `whether session ${session.sessionId} has a conversation could not be seen (${transcript.error})`;
  }
  if (transcript === "present" || session.answered === "no") return null;
  return session.answered === "yes"
    ? `session ${session.sessionId} has a conversation but no transcript to resume it from (is session persistence off?), so a restart would lose it`
    : `this Claude Code does not say whether session ${session.sessionId} has a conversation, and it has no transcript to resume one from`;
}

// The session the restart starts on, read once Claude Code has exited: its
// conversation resumed when its transcript is there, else a fresh start on
// its id.
function sessionStartOf(
  session: LaneSession,
  transcript: Presence,
): SessionStart | { readonly kind: "unchecked"; readonly error: string } {
  if (typeof transcript === "object") {
    return { kind: "unchecked", error: transcript.error };
  }
  return {
    kind: transcript === "present" ? "resume" : "fresh",
    sessionId: session.sessionId,
  };
}

// How the restart's report names the session it started on.
const STARTED: Readonly<
  Record<SessionStart["kind"], (sessionId: string) => string>
> = {
  resume: (id) => `resuming ${id}`,
  fresh: (id) => `starting ${id} afresh, since it had no conversation yet`,
};

// [LAW:single-enforcer] What ending the Claude Code a pane shows would lose,
// or null when nothing: the one judgement the restart makes before its kill.
// A stash, a turn in progress, and a draft die with the process; a dialog
// (a permission prompt waiting on a tool call) and a pane in copy mode are
// screens no judgement here can read past.
const UNREADABLE: Record<Exclude<PromptState["kind"], "ready">, string> = {
  "in-mode": "its pane is in tmux copy mode — leave it (q)",
  stashed:
    "it holds a stashed prompt (ctrl+s), which ending it would lose — restore or send it",
  "no-prompt":
    "it is not at its prompt (a dialog or picker is open) — close it",
};

function endingLoses(snapshot: PaneSnapshot): string | null {
  const state = promptState(snapshot);
  if (state.kind !== "ready") return UNREADABLE[state.kind];
  if (turnRunning(snapshot)) {
    return "it is in the middle of a turn, which ending it would end — wait until it is idle";
  }
  if (draftShown(snapshot)) {
    return "its prompt holds a draft, which ending it would lose — send or clear it";
  }
  return null;
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
