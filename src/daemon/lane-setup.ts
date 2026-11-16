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
// pane's prompt), so a test drives every plan with fakes. The renderer asks
// for each as an act (src/renderer/lane-acts.ts), and the host performs it
// (src/daemon/acts.ts).

import type { SessionId } from "./foundations/session-id.js";
import path from "node:path";
import { CLAUDE_CONFIG_DIR_ENV } from "../claude-settings.js";
import { CONFIG_ENV } from "../config-hint.js";
import { LANES, type Lane } from "../config/lanes.js";
import type { SessionFacts } from "./foundations/session-env.js";
import type { TmuxHint } from "../tmux-hint.js";
import {
  typeInPane,
  typeSlash,
  type ClaudeInputEdge,
} from "../claude-input/typing.js";
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
import type { Presence } from "../utils/presence.js";
import { sourceCheckoutOf } from "./build-currency.js";
import {
  attachCommandLine,
  attachLauncherOf,
  moduleGraphReaderOf,
} from "../attach-launcher.js";
import type { LauncherNode } from "../attach-preload.js";
import { BadVerbArgs } from "./foundations/verb-error.js";
import type { LaneSession } from "../renderer-interface/interface.js";

// The band mod, as the checkout's marketplace (`.claude-plugin/
// marketplace.json`) names it.
export const BAND_PLUGIN = "candybar-band@cc-candybar";
// The native client the band mod starts, beside its folder (mod/README.md).
const BAND_CLIENT = path.join("bin", "cc-candybar-native");
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
    sessionId: SessionId,
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

// [LAW:types-are-the-program] A lane act's session: its id, and what the act
// carries of it.
export type LaneAt = LaneSession & { readonly sessionId: SessionId };

// Each lane act's setup, which resolves with what it did once it has
// finished: the band's install and B's restart outlive the click that asked
// for them. A refusal is the user's to act on, thrown as BadVerbArgs with what
// to do.

// The band mod installed from this daemon's checkout and loaded into the
// session's Claude Code.
export async function bandOn(
  session: LaneAt,
  tmux: TmuxHint,
  host: LaneHost,
  edge: LaneEdge,
): Promise<string> {
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
  return installBand(session, tmux, checkout, edge);
}

// Claude Code in the pane restarted under the attach launcher.
export async function restartClaude(
  session: LaneAt,
  tmux: TmuxHint,
  host: LaneHost,
  edge: LaneEdge,
): Promise<string> {
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
  return restartUnderAttach(
    session,
    tmux,
    { node: host.node[0]!, launcher, preload: host.preload },
    edge,
  );
}

// The bar pane split under `tmux`, unless one already draws its bar.
export async function paneOn(
  tmux: TmuxHint,
  host: LaneHost,
  edge: LaneEdge,
): Promise<string> {
  const open = await edge.barPanes(tmux);
  if (open.length > 0)
    return `bar pane ${open.join(", ")} already draws ${tmux.pane}'s bar`;
  const opened = await edge.openBarPane(
    tmux,
    [...host.node, host.bundle, "bar-pane", tmux.pane],
    { CC_CANDYBAR_SOCKET: host.socket },
  );
  return `opened bar pane ${opened} under ${tmux.pane}`;
}

// Every bar pane drawing `tmux`'s bar closed.
export async function paneOff(tmux: TmuxHint, edge: LaneEdge): Promise<string> {
  const open = await edge.barPanes(tmux);
  for (const pane of open) await edge.closePane(tmux, pane);
  return open.length === 0
    ? `no bar pane draws ${tmux.pane}'s bar`
    : `closed bar pane ${open.join(", ")}`;
}

// [LAW:no-ambient-temporal-coupling] The `claude` CLI takes most of a second,
// so the install runs off the daemon's loop, after the click is answered.
async function installBand(
  session: LaneAt,
  tmux: TmuxHint,
  checkout: string,
  edge: LaneEdge,
): Promise<string> {
  const facts: SessionFacts = {
    sessionId: session.sessionId,
    projectDir: session.projectDir,
    claudeConfigDir: session.claudeConfigDir ?? undefined,
  };
  await edge.claude(["plugin", "marketplace", "add", checkout], facts);
  await edge.claude(["plugin", "install", BAND_PLUGIN], facts);
  const typed = await typeSlash(
    typeInPane(edge.claudeInput),
    tmux,
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
  session: LaneAt,
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
  session: LaneAt,
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
  session: LaneAt,
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
  Record<SessionStart["kind"], (sessionId: SessionId) => string>
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
