// [LAW:no-silent-failure] A probe the launch rate limit refused is not a fact
// about the system — it is the doctor declining to look twice inside a
// second. The machine's reads answer it as data, so it crosses a process like
// any other answer; the gather, their one reader, throws it, never folding it
// into the facts: a refused tmux query would otherwise read as a terminal tmux
// could not name, and a mark made on it would be filed under that. The verbs
// refuse the click with its message.
import type { Asked } from "../utils/outcome.js";

export interface Busy {
  readonly kind: "busy";
  // What the doctor declined to look at again.
  readonly what: string;
}

// A rate-limited probe's answer: the question's, or the limiter's refusal.
export type Probed<T> = Asked<T> | Busy;

export const busy = (what: string): Busy => ({ kind: "busy", what });

export class DoctorBusy extends Error {
  constructor(what: string) {
    super(`the doctor looked at ${what} less than a second ago — click again`);
    this.name = "DoctorBusy";
  }
}

// [LAW:single-enforcer] Where a refusal leaves the data: the gather's read of a
// probe's answer.
export async function seen<T>(answer: Promise<Probed<T>>): Promise<Asked<T>> {
  const probed = await answer;
  if (probed.kind === "busy") throw new DoctorBusy(probed.what);
  return probed;
}
