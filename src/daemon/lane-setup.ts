// What turning an animation lane on or off takes beyond the daemon's own gate
// (src/config/lanes.ts): a lane's toggle writes its switch, and the daemon's
// FrameFeeds admit or refuse its subscriber by it, but each lane's subscriber
// has to be RUNNING to subscribe, and none of them starts itself:
//
//   A, band       — the candybar-band mod (`<checkout>/mod`), loaded by Claude
//                   Code: installed from the checkout's own marketplace, read
//                   in place, then `/reload-plugins` loads it into the session.
//   B, statusline — Claude Code started under cc-extra's `bin/cc-attach`, whose
//                   `statusline-push` seam feeds the statusline the daemon's
//                   frames. It attaches only at process start (cc-extra's
//                   SEAMS.md: JSC gives debug hooks only to code compiled while
//                   a debugger is attached), so the session's Claude Code is
//                   exited and started again under it, resuming the session.
//   C, pane       — `cc-candybar bar-pane <pane>`, in a tmux pane split under
//                   the session's.
//
// [LAW:effects-at-boundaries] Each lane's setup is a plan over `LaneEdge`, the
// record holding every effect (tmux, the `claude` CLI, the process table, the
// pane's prompt), so a test drives every plan with fakes. A refusal is the
// user's to act on, thrown as BadVerbArgs with what to do, and the click shows
// it (src/daemon/click-error.ts).

import path from "node:path";
import { LANES, type Lane, type LaneSwitches } from "../config/lanes.js";
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
import { turnRunning } from "../claude-input/prompt-screen.js";
import { relaunchArgs } from "./claude-relaunch.js";
import { sourceCheckoutOf } from "./build-currency.js";
import { BadVerbArgs } from "./verb-error.js";

// The band mod, as the checkout's marketplace (`.claude-plugin/
// marketplace.json`) names it.
export const BAND_PLUGIN = "candybar-band@cc-candybar";
// The native client the band mod starts, beside its folder (mod/README.md).
const BAND_CLIENT = path.join("bin", "cc-candybar-native");
// The tmux pane option naming, on a bar pane the daemon opened, the pane whose
// bar it draws: how the daemon finds its bar panes again to close them.
export const BAR_PANE_OPTION = "@cc-candybar-bar-pane";
// How long the session's Claude Code has to exit after `/exit` before the
// restart under cc-attach is given up on.
export const EXIT_PATIENCE_MS = 15_000;

const RELOAD_PLUGINS = slashLine("/reload-plugins");
const EXIT = slashLine("/exit");

// The Claude Code a session's pane shows: the pane's foreground process,
// whether the pane's own first process is a shell it was started from (so a
// restart has somewhere to run), whether it already runs under cc-attach, and
// the directory it runs in.
export interface PaneClaude {
  readonly pid: number;
  readonly argv: readonly string[];
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
  // Write a script only this user can read, its text written knowing its own
  // path; answers that path.
  readonly writeScript: (
    name: string,
    text: (self: string) => string,
  ) => string;
  // Resolves true once `pid` has exited, false if it is still running after
  // `withinMs`.
  readonly exited: (pid: number, withinMs: number) => Promise<boolean>;
  // Type `line` into the pane's shell and run it.
  readonly typeShellLine: (tmux: TmuxHint, line: string) => void;
}

// This daemon: the bundle it runs, how node runs it, and its socket — what a
// bar pane runs to follow this daemon's frames.
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
    on: (session, _host, edge) => {
      const tmux = paneOf(session);
      return {
        kind: "underway",
        said: `restarting Claude Code in ${tmux.pane} under cc-attach`,
        finished: restartUnderAttach(session, tmux, edge),
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
    off: (session, _host, edge) => {
      const tmux = paneOf(session);
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

// Exit the pane's Claude Code and start it again under cc-attach, resuming the
// session — off the daemon's loop: reading the process table and waiting for
// the exit outlast a click.
async function restartUnderAttach(
  session: LaneSession,
  tmux: TmuxHint,
  edge: LaneEdge,
): Promise<string> {
  const claude = await edge.paneClaude(tmux);
  if (claude.attached) {
    return `left Claude Code in ${tmux.pane} running: it already runs under cc-attach`;
  }
  // [LAW:no-silent-failure] `/exit` typed mid-turn queues until the turn
  // ends, long after the wait below gives up — and then the session exits
  // with nothing to start it again.
  if (turnRunning(edge.claudeInput.read(tmux))) {
    throw new Error(
      `Claude Code in ${tmux.pane} is in the middle of a turn, and restarting it under cc-attach would end that turn — once it is idle, turn ${LANES.statusline.label} off and on again`,
    );
  }
  if (!claude.fromShell) {
    throw new Error(
      `Claude Code is the first process of pane ${tmux.pane}, so nothing would be left in the pane to start it again under cc-attach — start Claude Code from a shell in the pane`,
    );
  }
  const relaunch = relaunchArgs(claude.argv, session.sessionId);
  if (relaunch.kind === "refused") {
    throw new Error(`${relaunch.reason} — start it under cc-attach yourself`);
  }
  const script = edge.writeScript(`relaunch-${session.sessionId}.sh`, (self) =>
    relaunchScript(self, claude.cwd, relaunch.args),
  );
  const typed = typeSlash(edge.claudeInput, tmux, EXIT);
  if (typed.kind === "refused") {
    throw new Error(
      `Claude Code was not restarted under cc-attach: /exit was not typed: ${typed.reason}`,
    );
  }
  if (!(await edge.exited(claude.pid, EXIT_PATIENCE_MS))) {
    throw new Error(
      `Claude Code in ${tmux.pane} did not exit within ${EXIT_PATIENCE_MS / 1000} s of /exit, so it was not restarted under cc-attach`,
    );
  }
  edge.typeShellLine(tmux, `sh ${script}`);
  return `restarted Claude Code in ${tmux.pane} under cc-attach, resuming ${session.sessionId}`;
}

// [LAW:single-enforcer] The one owner of lane setup: the click's verb asks it
// to bring a lane in line with the session's switch, and it alone hears how a
// setup that outlives the click ends — logged, and a failure held on the bar
// as a click's failure is (src/daemon/click-error.ts).
export class LaneSetups {
  constructor(
    private readonly deps: {
      readonly edge: LaneEdge;
      readonly host: LaneHost;
      // Whether each lane is on for the session, as its next render resolves
      // it — the toggle's write included.
      readonly switches: (session: LaneSession) => LaneSwitches;
      readonly state: SessionStateRW;
      readonly log: (level: "info" | "warn", msg: string) => void;
      readonly now: () => Instant;
    },
  ) {}

  sync(session: LaneSession, lane: Lane): string {
    const on = this.deps.switches(session)[lane];
    const outcome = LANE_SETUP[lane][on ? "on" : "off"](
      session,
      this.deps.host,
      this.deps.edge,
    );
    const said = `lane: ${lane} ${on ? "on" : "off"} — ${outcome.said} (session=${session.sessionId})`;
    this.deps.log("info", said);
    if (outcome.kind === "underway") {
      outcome.finished.then(
        (finished) =>
          this.deps.log(
            "info",
            `lane: ${lane} ${finished} (session=${session.sessionId})`,
          ),
        (error: unknown) => {
          const text = `lane: ${error instanceof Error ? error.message : String(error)}`;
          this.deps.log("warn", `${text} (session=${session.sessionId})`);
          holdClickError(
            this.deps.state,
            session.sessionId,
            text,
            this.deps.now(),
          );
        },
      );
    }
    return said;
  }
}

// POSIX single quotes: everything literal, a quote spelled `'\''`.
const shQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

// [LAW:effects-at-boundaries] The script a shell runs to start the session
// again under cc-attach. It is typed as `sh <script>`, a line every shell
// reads alike, so no quoting has to survive the user's shell (fish quotes
// differently from sh). It removes itself first, resumes the session in the
// directory Claude Code ran in, and — where cc-attach is not on PATH — says
// so and resumes it in stock Claude Code, so the session is never left
// stopped.
export function relaunchScript(
  self: string,
  cwd: string,
  args: readonly string[],
): string {
  const argv = args.map(shQuote).join(" ");
  return [
    `rm -f -- ${shQuote(self)}`,
    `cd -- ${shQuote(cwd)} || exit 1`,
    `if command -v cc-attach >/dev/null 2>&1; then exec cc-attach ${argv}; fi`,
    `echo ${shQuote(`cc-candybar: ${LANES.statusline.label} needs cc-extra's bin/cc-attach on PATH — resuming this session in stock Claude Code`)} >&2`,
    `exec claude ${argv}`,
    "",
  ].join("\n");
}
