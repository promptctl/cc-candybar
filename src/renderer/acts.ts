// [LAW:single-enforcer] How every act but a config write leaves the renderer:
// as an effect its turn returns, which the host's interpreter performs. Each is
// held here from the turn that returned it until its `effect-done`, so an
// act that failed is held on its session's bar like a click's own failure. One
// whose click named no session has no bar: the host holds that one on every
// bar (src/daemon/renderer-host.ts).

import type { SessionId } from "../daemon/foundations/session-id.js";
import { holdClickError } from "../daemon/foundations/click-error.js";
import type { SessionStateRW } from "../renderer-interface/session-state.js";
import type {
  Act,
  Effect,
  EffectId,
  EffectOutcome,
} from "../renderer-interface/interface.js";
import type { Instant } from "../utils/instant.js";

// An act as a step asks for it: the renderer mints its id. The repository
// answer is not one: it lands with the click's config changes
// (src/renderer/config-writes.ts).
export type ActRequest =
  Exclude<Act, { kind: "approve-repo" }> extends infer A
    ? A extends unknown
      ? Omit<A, "id">
      : never
    : never;

export class Acts {
  // Each act on its way, by the id its `effect-done` names.
  private readonly owed = new Map<
    EffectId,
    { readonly kind: Act["kind"]; readonly session: SessionId | null }
  >();

  constructor(
    private readonly deps: {
      readonly mint: () => EffectId;
      readonly sessionState: SessionStateRW;
      readonly now: () => Instant;
    },
  ) {}

  // The act joins the turn's effects, in the order its steps asked.
  add(effects: Effect[], act: ActRequest): void {
    const id = this.deps.mint();
    this.owed.set(id, { kind: act.kind, session: act.session });
    effects.push({ ...act, id } as Act);
  }

  // An act's `effect-done`: false for an id no act of this renderer's holds.
  // [LAW:no-silent-failure] A failed act with a bar shows there.
  settled(id: EffectId, outcome: EffectOutcome): boolean {
    const act = this.owed.get(id);
    if (act === undefined) return false;
    this.owed.delete(id);
    if (outcome.kind !== "ok" && act.session !== null)
      holdClickError(
        this.deps.sessionState,
        act.session,
        `${act.kind}: ${outcome.reason}`,
        this.deps.now(),
      );
    return true;
  }
}
