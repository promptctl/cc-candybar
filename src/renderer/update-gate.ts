// The update notice's dismiss gate, as the renderer holds it: the one value a
// dismiss link may write is the identity of the update the newest fact names,
// so a stale dismissal simply stops matching.
//
// [LAW:one-source-of-truth] The fact is the host's, carried in every session's
// world state; the gate is the renderer's, because the renderer's loads are
// what it gates. Documents of different sessions arrive in no order between
// them, so the gate follows the newest answered fact by its stamp, and a late
// document carrying an older one does not move it back; one read at the same
// instant is as new, so a held clock still moves it. A pending fact has not
// been read yet and moves nothing.

import type { Fact } from "../facts/fact.js";
import type { Update } from "../facts/world-state.js";
import type { Gates } from "../daemon/foundations/gates.js";
import { UPDATE_DISMISSED_KEY } from "../daemon/foundations/update-keys.js";
import { updateIdentity } from "../daemon/foundations/update-offer.js";
import type { Instant } from "../utils/instant.js";

export class UpdateGate {
  private newest: Instant | null = null;
  private gate: {
    readonly identity: string;
    readonly dispose: () => void;
  } | null = null;

  constructor(private readonly gates: Gates) {}

  took(fact: Fact<Update>): void {
    if (fact.kind === "pending") return;
    if (this.newest !== null && fact.at < this.newest) return;
    this.newest = fact.at;
    const identity = fact.kind === "ok" ? updateIdentity(fact.value) : null;
    if ((this.gate?.identity ?? null) === identity) return;
    this.gate?.dispose();
    this.gate =
      identity === null
        ? null
        : {
            identity,
            dispose: this.gates.state.register(UPDATE_DISMISSED_KEY, [
              identity,
            ]),
          };
  }
}
