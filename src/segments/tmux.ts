import { runTmuxAsync } from "../proc/tmux";
import type { TmuxHint } from "../tmux-hint";
import { debug } from "../utils/logger";
import { ABSENT, failed, ok, type Outcome } from "../utils/outcome";
import { SingleFlight } from "../utils/single-flight";

// How long a pane's session name stands before the next render asks tmux
// again. A pane's session can be renamed, the pane moved to another session,
// and a pane id reused by a new server on the same socket; a failure may be a
// timeout on a loaded machine. This bounds how late the bar learns of any of
// them.
const NAME_TTL_MS = 30_000;
const MAX_ENTRIES = 64;

interface Entry {
  readonly outcome: Outcome<string>;
  readonly at: number;
}

// A socket path cannot hold a newline's worth of pane id, so the pair is
// unambiguous.
const keyOf = (hint: TmuxHint): string => `${hint.socket}\n${hint.pane}`;

// The session name of the pane a session's CLIENT reported (src/tmux-hint.ts):
// its server socket and its pane id. The daemon is detached, so its own
// TMUX/TMUX_PANE answer for whichever shell spawned it and are never read here
// (brandon-tmux-tk7).
//
// [LAW:single-enforcer] One owner of the readings and of the one tmux
// invocation a pane may have in flight, so concurrent renders share a spawn
// and a render never spawns for a pane whose reading still stands.
export class TmuxService {
  private readonly names = new Map<string, Entry>();
  private readonly asking = new SingleFlight();

  constructor(private readonly now: () => number = Date.now) {}

  // ok — the session name; absent — tmux answered with an empty name; failed
  // — the invocation itself failed, carried to the payload boundary as a
  // value ([LAW:no-silent-failure]) and asked again once it expires. An
  // expired reading is still drawn while its replacement is fetched, so only a
  // pane with no reading at all waits on tmux.
  //
  // [LAW:types-are-the-program] Takes the pane to ask about. "Not in tmux" is
  // the caller's fact (the hint is null), so there is no pane-less call to
  // answer.
  getSessionName(hint: TmuxHint): Promise<Outcome<string>> {
    const key = keyOf(hint);
    const cached = this.names.get(key);
    if (cached && this.now() - cached.at < NAME_TTL_MS) {
      return Promise.resolve(cached.outcome);
    }
    const fetched = this.asking.run(key, () => this.ask(key, hint));
    return cached ? Promise.resolve(cached.outcome) : fetched;
  }

  private async ask(key: string, hint: TmuxHint): Promise<Outcome<string>> {
    debug(`Getting tmux session name for pane ${hint.pane} on ${hint.socket}`);

    const run = await runTmuxAsync(hint, "tmux", [
      "display-message",
      "-p",
      "-t",
      hint.pane,
      "#S",
    ]);
    const name = run.kind === "ok" ? run.stdout.trim() : "";
    const outcome: Outcome<string> =
      run.kind !== "ok" ? failed(run.reason) : name ? ok(name) : ABSENT;
    this.names.delete(key);
    this.names.set(key, { outcome, at: this.now() });
    while (this.names.size > MAX_ENTRIES) {
      this.names.delete(this.names.keys().next().value!);
    }
    return outcome;
  }
}
