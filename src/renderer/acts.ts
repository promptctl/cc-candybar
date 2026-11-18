// [LAW:single-enforcer] How what a click or a lane switch asks done in the
// world leaves the renderer: as an act its turn returns, which the host
// performs once the turn's changes have landed (src/daemon/acts.ts), never as
// a reach into the host. Each act is held here from its turn until its one
// `effect-done`, and an act that did not go shows on its session's bar the
// way its click's own failure would. An act the daemon's close cut off is no
// failure of its own, and one with no session is the host's to show.

import type { SessionId } from "../daemon/foundations/session-id.js";
import type {
  ActRequest,
  OwedEffect,
  EffectId,
  EffectOutcome,
} from "../renderer-interface/interface.js";

export class ActsOnTheirWay {
  private readonly owed = new Set<EffectId>();

  constructor(
    private readonly mint: () => EffectId,
    // Holds a failed act's reason on its session's bar.
    private readonly failed: (session: SessionId, reason: string) => void,
  ) {}

  // `act` asked of the host, in the turn whose effects are `effects`.
  ask(effects: OwedEffect[], act: ActRequest): void {
    const id = this.mint();
    this.owed.add(id);
    effects.push({ ...act, id });
  }

  // An act's `effect-done`: false for an id no act of this renderer's holds.
  done(
    id: EffectId,
    session: SessionId | null,
    outcome: EffectOutcome,
  ): boolean {
    if (!this.owed.delete(id)) return false;
    if (
      session !== null &&
      (outcome.kind === "failed" || outcome.kind === "refused")
    )
      this.failed(session, outcome.reason);
    return true;
  }
}
