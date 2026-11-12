// A click's copy that the host could not write to the clipboard, held for the
// bar. The copy names no session, and the URL handler reads no reply, so the
// bar is the only place a person sees it: daemon-wide, as the launcher's pipe
// event is, under the daemon's one rule for an event-shaped error
// (src/utils/event-hold.ts).

import { CLICK_ERROR_HOLD_S } from "../daemon/click-error.js";
import type { Drawing } from "../config/lanes.js";
import {
  answeredBy,
  eventHoldAt,
  type HeldEvent,
} from "../utils/event-hold.js";
import type { Instant } from "../utils/instant.js";

export interface CopyFailedWarning {
  readonly kind: "copy-failed";
  readonly message: string;
  // The record the warning shows, which an answer carrying it marks answered.
  readonly event: HeldEvent;
  // Why this render shows it: inside the hold, or owed past it.
  readonly hold: "held" | "owed";
}

// [LAW:no-shared-mutable-globals] The renderer's one record of it: its
// effect-done turn writes it, a draw reads it, and an answer that carried it
// marks it. The newest failure replaces an older one, because what the
// clipboard holds now is what the newest says.
export class CopyFailures {
  private last: HeldEvent | null = null;

  failed(reason: string, at: Instant): void {
    this.last = { text: `copy failed: ${reason}`, at, answered: false };
  }

  warnings(at: Instant, render: Drawing["by"]): CopyFailedWarning[] {
    const event = this.last;
    if (event === null) return [];
    const hold = eventHoldAt(event, CLICK_ERROR_HOLD_S, at, render);
    return hold === "over"
      ? []
      : [{ kind: "copy-failed", message: event.text, event, hold }];
  }

  // [LAW:single-enforcer] An answer carrying `shown` reached its client.
  answered(shown: HeldEvent): void {
    const last = this.last;
    if (last === null || !answeredBy(last, shown)) return;
    this.last = { ...last, answered: true };
  }
}
