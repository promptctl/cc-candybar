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
//   C, tmuxStatus — none: the daemon itself follows the session's frames and
//                   writes them into its tmux status line while the switch is
//                   on (src/daemon/tmux-status.ts).
//
// [LAW:effects-at-boundaries] Each lane's setup is a plan over `LaneEdge`, the
// record holding every effect (tmux, the `claude` CLI, the process table, the
// pane's prompt), so a test drives every plan with fakes. A refusal is the
// user's to act on, thrown as BadVerbArgs with what to do, and the click shows
// it (src/daemon/click-error.ts).

import path from "node:path";
import { CLAUDE_CONFIG_DIR_ENV } from "../claude-settings.js";
import { CONFIG_ENV } from "../config-hint.js";
import {
  LANES,
  LANE_NAMES,
  type Lane,
  type LaneSwitches,
} from "../config/lanes.js";
import { holdClickError } from "./click-error.js";
import type { SessionFacts } from "./session-env.js";
import type { SessionStateRW } from "./session-state.js";
import type { Instant } from "../utils/instant.js";
import type { ClientHints } from "./protocol.js";
import type { RenderOrigin } from "../config-hint.js";
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
import type { LauncherNode } from "../attach-preload.js";
import { BadVerbArgs } from "./verb-error.js";
import { KeyedSerialQueue } from "../utils/keyed-serial-queue.js";

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
  // The process that started it: the shell the restart line is typed into
  // when `fromShell`.
  readonly parent: number;
  readonly fromShell: boolean;
  readonly attached: boolean;
}

export interface LaneEdge {
  readonly claudeInput: ClaudeInputEdge;
  // The bar panes the daemon opened for `tmux.pane`.
  readonly barPanes: (tmux: TmuxHint) => Promise<readonly string[]>;
  // Split a pane under `tmux.pane` running `argv` with `env`, tagged as its
  // bar pane; answers the new pane's id.
  readonly openBarPane: (
    tmux: TmuxHint,
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
  ) => Promise<string>;
  readonly closePane: (tmux: TmuxHint, pane: string) => Promise<void>;
  // Run the `claude` CLI in the session's process environment; rejects with
  // its own words when it fails.
  readonly claude: (
    args: readonly string[],
    session: SessionFacts,
  ) => Promise<void>;
  readonly fileExists: (file: string) => boolean;
  readonly presence: (file: string) => Presence;
  readonly paneClaude: (tmux: TmuxHint) => Promise<PaneClaude>;
  // The directory of the pane's shell `shell` once it holds the pane's
  // terminal again: when the Claude Code it started has exited, the
  // directory Claude Code was started in.
  readonly paneDir: (tmux: TmuxHint, shell: number) => Promise<string>;
  // The node the attach launcher would run under, started with
  // `pathVariable` (`launcherNode`, src/attach-preload.ts).
  readonly launcherNode: (pathVariable: string | undefined) => LauncherNode;
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
  readonly typeShellLine: (tmux: TmuxHint, line: string) => Promise<void>;
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
) => Promise<LaneOutcome>;

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
    on: async (session, host, edge) => {
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
    off: async () =>
      done("nothing to stop: the band mod draws nothing while the lane is off"),
  },
  statusline: {
    on: async (session, host, edge) => {
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
    off: async () =>
      done(
        "nothing to stop: the attached statusline draws its command's output while the lane is off",
      ),
  },
  pane: {
    on: async (session, host, edge) => {
      const tmux = paneOf(session);
      const open = await edge.barPanes(tmux);
      if (open.length > 0) {
        return done(
          `bar pane ${open.join(", ")} already draws ${tmux.pane}'s bar`,
        );
      }
      const opened = await edge.openBarPane(
        tmux,
        [...host.node, host.bundle, "bar-pane", tmux.pane],
        { CC_CANDYBAR_SOCKET: host.socket },
      );
      return done(`opened bar pane ${opened} under ${tmux.pane}`);
    },
    // Off is "no bar pane draws this session's bar", which a session with no
    // tmux pane already is.
    off: async (session, _host, edge) => {
      const pane = tmuxPaneOf(session.hints.tmux);
      if (pane.kind === "refused") {
        return done(`no bar pane to close: ${pane.reason}`);
      }
      const tmux = pane.hint;
      const open = await edge.barPanes(tmux);
      for (const pane of open) await edge.closePane(tmux, pane);
      return done(
        open.length === 0
          ? `no bar pane draws ${tmux.pane}'s bar`
          : `closed bar pane ${open.join(", ")}`,
      );
    },
  },
  // The daemon draws the tmux status line itself, for every session whose
  // switch is on (src/daemon/tmux-status.ts), so there is nothing to start or
  // stop — only a session outside tmux to tell why nothing will be drawn.
  tmuxStatus: {
    on: async (session) => {
      const tmux = paneOf(session);
      return done(`the daemon draws ${tmux.pane}'s bar in its status line`);
    },
    off: async () =>
      done(
        "nothing to stop: the daemon puts the status line back once the lane is off",
      ),
  },
};

// [LAW:no-ambient-temporal-coupling] The `claude` CLI takes most of a second,
// so the install runs off the daemon's loop, after the click is answered.
async function installBand(
  session: LaneSession,
  checkout: string,
  edge: LaneEdge,
): Promise<string> {
  const facts: SessionFacts = {
    sessionId: session.sessionId,
    projectDir: session.origin.projectDir,
    claudeConfigDir: session.hints.claudeConfigDir,
  };
  await edge.claude(["plugin", "marketplace", "add", checkout], facts);
  await edge.claude(["plugin", "install", BAND_PLUGIN], facts);
  const typed = await typeSlash(
    edge.claudeInput,
    session.hints.tmux,
    RELOAD_PLUGINS,
  );
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
// Code was started with them: the ones that decide which session and which
// bar the restart comes back to — its Claude Code directory, which `--resume`
// also looks the session up under, and its cc-candybar config, which decides
// whether lane B is on. The rest of the environment is the shell's own,
// which the shell the line is typed into still exports, and the line lands
// in the shell's history, where a credential must never be written.
const CARRIED_ENV: ReadonlySet<string> = new Set([
  CLAUDE_CONFIG_DIR_ENV,
  CONFIG_ENV,
]);

// [LAW:parse-dont-validate] An environment as a process image carries it,
// `NAME=value` each, read once into its variables.
function environmentOf(env: readonly string[]): ReadonlyMap<string, string> {
  return new Map(
    env.flatMap((v) => {
      const at = v.indexOf("=");
      return at > 0 ? [[v.slice(0, at), v.slice(at + 1)] as const] : [];
    }),
  );
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
  const loses = endingLoses(await edge.claudeInput.read(tmux));
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
  const started = environmentOf(claude.env);
  const searched = started.get("PATH");
  // [LAW:no-silent-failure] The preload starts the launcher under the node
  // the line's shell finds; one it would refuse is refused before the kill.
  const node = edge.launcherNode(searched);
  if (node.kind === "refused") {
    throw new Error(
      `Claude Code in ${tmux.pane} was left running, under the PATH it was started with: ${node.why}`,
    );
  }
  // The line names `claude` when the shell would find this same release by
  // that word: the release's own path is removed by Claude Code's next
  // update, and a rerun from history would then find nothing there.
  const program =
    edge.onPath("claude", searched) === claude.executable
      ? "claude"
      : claude.executable;
  const env = [...started].filter(([name]) => CARRIED_ENV.has(name));
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
    startDir = await edge.paneDir(tmux, claude.parent);
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
    await edge.typeShellLine(tmux, line);
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

// How many sessions' owed setups LaneSetups keeps.
const MAX_SESSIONS_OWED = 1024;

// What started a setup: the session's own click, or its first request after
// a click this daemon could not set up then.
type SetupCause = "click" | "owed";

// The lanes a session's clicks moved and no setup has brought in line yet,
// each by where its switch stood before the first of those clicks: what the
// lane runs, as far as this daemon knows.
type Owed = Map<Lane, boolean>;

// [LAW:single-enforcer] The one owner of lane setup. What a lane runs follows
// the session's own clicks on its switch, whatever control moved it — the
// menu's toggle, its ↺, ↶ undo, a preset picked, a save — so no control
// carries the setup itself (review of brandon-menus-sjhy.amf). The click path
// measures the session's switches before the click and after its commit
// (`journaled`, src/daemon/verbs/index.ts), and each lane that differs is
// brought in line once, after the click. A switch moved by anything but the
// session's own click — another session's save, a hand edit, a restart, a
// `cd` — sets nothing up: it changes what every session reading that file
// renders by, and setting a lane up in each would restart every idle Claude
// Code on the machine for one session's save. A setup needs the session as
// its latest request reported it; a click before this daemon holds one (a
// toggle on a bar the daemon before a restart drew) owes its setups to the
// session's next click or request, whichever comes first. What is owed is
// settled against the switches as that event finds them, so a lane whose
// switch is back where it stood — toggled back, or moved back by another
// session's save — owes nothing. One session's setups run one at a time,
// each after the last has finished — two restarts of one pane would type over
// each other. How each setup ends is logged, and a failure is held on the bar
// as a click's failure is (src/daemon/click-error.ts).
export class LaneSetups {
  // Each session's owed lanes, least recently owed first.
  private readonly owed = new Map<string, Owed>();
  // [LAW:no-ambient-temporal-coupling] Each session's setups, one at a time.
  private readonly setups = new KeyedSerialQueue<string>();

  constructor(
    private readonly deps: {
      readonly edge: LaneEdge;
      readonly host: LaneHost;
      readonly state: SessionStateRW;
      readonly log: (level: "info" | "warn", msg: string) => void;
      readonly now: () => Instant;
      // [LAW:effects-at-boundaries] Runs a setup in the turn after the click
      // or request that started it, so what that turn still does after
      // `clicked` (the click's view follow) lands first.
      readonly defer: (run: () => void) => void;
    },
  ) {}

  // A click of `sessionId` moved its switches from `before` to `after`.
  // `session` is the session as its latest request reported it, or null when
  // this daemon holds none yet.
  clicked(
    sessionId: string,
    session: LaneSession | null,
    before: LaneSwitches,
    after: LaneSwitches,
  ): void {
    // [LAW:one-source-of-truth] The click's moves join what the session
    // already owes: a lane owed before keeps where it stood then.
    const moved = LANE_NAMES.filter((lane) => before[lane] !== after[lane]);
    const owed = this.take(sessionId);
    for (const lane of moved) if (!owed.has(lane)) owed.set(lane, before[lane]);
    const byOf = (lane: Lane): SetupCause =>
      moved.includes(lane) ? "click" : "owed";
    if (session !== null) {
      this.settle(session, owed, after, byOf);
      return;
    }
    for (const [lane, from] of owed)
      if (from === after[lane]) owed.delete(lane);
    // [LAW:nothing-unseen] What a click before the session's first request
    // leaves owed is said at the click, so a setup that never runs still has
    // its line.
    if (moved.length > 0) {
      const lanes = [...owed.keys()].map(
        (lane) => `${lane} ${after[lane] ? "on" : "off"}`,
      );
      this.deps.log(
        "info",
        `lane: owed ${lanes.join(",") || "nothing"} (session=${sessionId})`,
      );
    }
    // [LAW:carrying-cost] Bounded like the daemon's other per-session
    // memories: least recently owed dropped first, and said.
    if (owed.size > 0) this.owed.set(sessionId, owed);
    for (const [oldest, lanes] of this.owed) {
      if (this.owed.size <= MAX_SESSIONS_OWED) break;
      this.owed.delete(oldest);
      this.deps.log(
        "warn",
        `lane: owed dropped sid=${JSON.stringify(oldest)} lanes=${[...lanes.keys()].join(",")}`,
      );
    }
  }

  // A request of `session` arrived, finding its switches at `switches`: the
  // setups its clicks owe start now.
  noted(session: LaneSession, switches: LaneSwitches): void {
    this.settle(session, this.take(session.sessionId), switches, () => "owed");
  }

  private take(sessionId: string): Owed {
    const owed = this.owed.get(sessionId) ?? new Map<Lane, boolean>();
    this.owed.delete(sessionId);
    return owed;
  }

  // [LAW:dataflow-not-control-flow] Each owed lane is brought to its switch
  // `now`, unless the switch stands where the lane already is, and either
  // way is said, under what started it: this click's move, or one owed from
  // before.
  private settle(
    session: LaneSession,
    owed: Owed,
    now: LaneSwitches,
    byOf: (lane: Lane) => SetupCause,
  ): void {
    for (const [lane, from] of owed) {
      if (now[lane] !== from) this.start(session, lane, now[lane], byOf(lane));
      else
        this.deps.log(
          "info",
          `lane: ${lane} ${from ? "on" : "off"} — nothing owed: its switch is back where the lane is by=${byOf(lane)} (session=${session.sessionId})`,
        );
    }
  }

  private start(
    session: LaneSession,
    lane: Lane,
    on: boolean,
    by: SetupCause,
  ): void {
    this.deps.defer(
      () =>
        void this.setups.run(session.sessionId, () =>
          this.sync(session, lane, on, by),
        ),
    );
  }

  // Resolves once the setup has finished, however it ended.
  private async sync(
    session: LaneSession,
    lane: Lane,
    on: boolean,
    by: SetupCause,
  ): Promise<void> {
    const where = `by=${by} (session=${session.sessionId})`;
    const failed = (error: unknown): void => {
      const text = `lane: ${lane} ${on ? "on" : "off"}: ${error instanceof Error ? error.message : String(error)}`;
      this.deps.log("warn", `${text} ${where}`);
      holdClickError(this.deps.state, session.sessionId, text, this.deps.now());
    };
    let outcome: LaneOutcome;
    try {
      outcome = await LANE_SETUP[lane][on ? "on" : "off"](
        session,
        this.deps.host,
        this.deps.edge,
      );
    } catch (error) {
      failed(error);
      return;
    }
    this.deps.log(
      "info",
      `lane: ${lane} ${on ? "on" : "off"} — ${outcome.said} ${where}`,
    );
    if (outcome.kind === "underway") {
      await outcome.finished.then(
        (finished) =>
          this.deps.log("info", `lane: ${lane} ${finished} ${where}`),
        failed,
      );
    }
  }
}
