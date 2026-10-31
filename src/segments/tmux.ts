import type { Launcher } from "../proc/launch";
import { runTmuxAsync } from "../proc/tmux";
import type { TmuxHint } from "../tmux-hint";
import type { Holds } from "../utils/holds";
import { KeyedSource, type KeyedSourceStats } from "../utils/keyed-source";
import { quietLogger, type DaemonLogger } from "../utils/logger";
import { RefreshLedger } from "../utils/refresh-ledger";
import type { Lane } from "../utils/reading";
import { valueOf } from "../utils/logfmt";
import { ABSENT, failed, ok, type Outcome } from "../utils/outcome";

// The period a held pane's session name is asked again on. A pane's session
// can be renamed, the pane moved to another session, and a pane id reused by
// a new server on the same socket; a failure may be a timeout on a loaded
// machine. This bounds how late the bar learns of any of them.
export const NAME_PERIOD_MS = 30_000;
const MAX_ENTRIES = 64;

// The session name of the pane a session's CLIENT reported (src/tmux-hint.ts):
// its server socket and its pane id. The daemon is detached, so its own
// TMUX/TMUX_PANE answer for whichever shell spawned it and are never read here
// (brandon-tmux-tk7).
//
// [LAW:single-enforcer] One owner of the readings and of the one tmux
// invocation a pane may have in flight (brandon-unfiled-3248.8ro6, step 1): a
// render takes the stored name, and only a pane never asked about waits on
// tmux. A pane is asked again on its period only while a home holds it, so a
// pane whose Claude Code exited costs no spawn once no render reads it
// (src/utils/holds.ts).
export class TmuxService {
  private readonly names: KeyedSource<TmuxHint, string>;

  constructor(opts: {
    readonly launcher: Launcher;
    readonly logger?: DaemonLogger;
    readonly ledger?: RefreshLedger;
  }) {
    const logger = opts.logger ?? quietLogger;
    this.names = new KeyedSource({
      name: "tmux",
      scope: "pane",
      // A socket path cannot hold a newline's worth of pane id, so the pair
      // is unambiguous.
      keyOf: (hint) => `${hint.socket}\n${hint.pane}`,
      fields: (hint) =>
        `pane=${valueOf(hint.pane)} socket=${valueOf(hint.socket)}`,
      read: (hint) => askSessionName(opts.launcher, hint),
      every: { okMs: NAME_PERIOD_MS, failedMs: NAME_PERIOD_MS },
      maxEntries: MAX_ENTRIES,
      logger,
      ledger: opts.ledger ?? new RefreshLedger(logger),
    });
  }

  // ok — the session name; absent — tmux answered with an empty name; failed
  // — the invocation itself failed, carried to the payload boundary as a
  // value ([LAW:no-silent-failure]) and logged once, by the refresh that
  // failed.
  //
  // [LAW:types-are-the-program] Takes the pane to ask about. "Not in tmux" is
  // the caller's fact (the hint is null), so there is no pane-less call to
  // answer.
  declare(holds: Holds, hint: TmuxHint): Lane<string> {
    return this.names.declare(holds, hint);
  }

  getStats(): KeyedSourceStats {
    return this.names.stats();
  }

  close(): void {
    this.names.close();
  }
}

async function askSessionName(
  launcher: Launcher,
  hint: TmuxHint,
): Promise<Outcome<string>> {
  const run = await runTmuxAsync(launcher, hint, "tmux", [
    "display-message",
    "-p",
    "-t",
    hint.pane,
    "#S",
  ]);
  if (run.kind !== "ok") return failed(run.reason);
  const name = run.stdout.trim();
  return name ? ok(name) : ABSENT;
}
