// Pure mapping from ClientOutcome to a render plan: what to write, whether
// to kick a fresh daemon, and (if relevant) the debug message that describes
// why. All variability lives in the returned value — including the debug
// string — so this module has no observable side effects. The runtime
// composition in src/index.ts consumes the plan and owns every side effect
// (debug logging, kick, write, exit).
//
// [LAW:dataflow-not-control-flow] Variability lives in the returned values
// (output string, kick flag, debug message). The caller's debug/kick/write/
// exit run unconditionally against those values — no caller-side branching
// on outcome.kind.
//
// [LAW:types-are-the-program] Exhaustive over ClientOutcome.kind. Adding a
// new variant fails typecheck rather than silently falling out the bottom
// of the switch.

import {
  formatHostBundleGlyph,
  formatPermanentGlyph,
} from "./render/error-glyph";
import { ANSI_RESET } from "./render/diagnostic-style";
import type { ClientOutcome } from "./daemon/client";
import type { KickOutcome } from "./daemon/acquire";
import { whyUnusable } from "./daemon/host-bundle";

const BOLD = "\x1b[1m";
const WAITING_FOR_DAEMON = "Candybar · waiting for daemon…";
const RENDER_TIMED_OUT = "Candybar timed out";
// The shell expands its own paths. No environment text reaches the terminal,
// and the diagnostic works while the daemon's request queue is blocked.
const DEFAULT_LOG_COMMAND = "tail -n 40 ~/.local/state/cc-candybar/daemon.log";
const XDG_LOG_COMMAND = 'tail -n 40 "$XDG_STATE_HOME/cc-candybar/daemon.log"';

export interface OutcomePlan {
  output: string;
  kick: boolean;
  // Debug message the caller should log, or null when there is nothing
  // worth logging (the "ok" path). Held as data so this module stays pure.
  debug: string | null;
}

// [LAW:no-silent-failure] A kick the install's record refused leaves nothing
// starting, so the waiting indicator would promise a daemon that never comes:
// the plan's output becomes the refusal, and its reason is the debug line.
// `null` is a plan that asked for no kick. A kick that ran leaves the plan as
// it was.
export function planAfterKick(
  plan: OutcomePlan,
  kick: KickOutcome | null,
): OutcomePlan {
  return kick?.kind === "refused"
    ? {
        output: formatHostBundleGlyph(kick.record.kind),
        kick: false,
        debug: `daemon unavailable, and nothing was spawned: ${whyUnusable(kick.record)}`,
      }
    : plan;
}

export function planOutcome(
  outcome: ClientOutcome,
  xdgStateHome: string | undefined,
): OutcomePlan {
  switch (outcome.kind) {
    case "ok":
      return { output: outcome.value, kick: false, debug: null };
    case "transient":
      return {
        output: `${BOLD}${WAITING_FOR_DAEMON}${ANSI_RESET}\n`,
        kick: true,
        debug: `daemon unavailable (transient: ${outcome.cause}: ${outcome.message}) — kicking daemon`,
      };
    // [LAW:one-type-per-behavior] The daemon's own TIMEOUT, or this client's
    // clock running out on a listener, means a daemon holds the socket, so
    // there is nothing to respawn: a kick would spawn a candidate that
    // loses the bind to the live daemon, once per render under load. The
    // Rust client's Busy variant does not kick either.
    case "busy": {
      const command = xdgStateHome ? XDG_LOG_COMMAND : DEFAULT_LOG_COMMAND;
      return {
        output: `${BOLD}${RENDER_TIMED_OUT}${ANSI_RESET} · ${command}\n`,
        kick: false,
        debug: `daemon busy (${outcome.message}) — not kicking`,
      };
    }
    case "permanent":
      return {
        output: formatPermanentGlyph(outcome),
        kick: false,
        debug: `daemon refused request (permanent: ${outcome.cause}) — not kicking`,
      };
  }
}
