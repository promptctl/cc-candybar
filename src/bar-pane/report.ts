// What the pane tells the host of its pointer between subscribes.
//
// [LAW:no-ambient-temporal-coupling] The host takes a report only from a pane
// whose stream it holds. A stream that is not open (the lane is switched off,
// the daemon is away, the subscribe has not landed) has nothing to tell it: the
// pane's facts ride the subscribe that opens the next, and the first frame of
// each stream restates them whole, so a change made while detached is not lost.
import type { OwnerFacts } from "../daemon/foundations/protocol";
import { describeFailure } from "../daemon/client-transport";
import type { tryPointerViaDaemon } from "../daemon/client";

// The pane's hold on the session it follows: whether the host holds its stream.
export interface Followed {
  readonly sessionId: string;
  readonly wire: { attached: boolean };
}

export async function reportPointer(
  followed: Followed | null,
  send: (
    sessionId: string,
    facts: OwnerFacts,
  ) => ReturnType<typeof tryPointerViaDaemon>,
  facts: () => OwnerFacts,
  fail: (message: string) => void,
): Promise<void> {
  if (followed === null || !followed.wire.attached) return;
  const sent = await send(followed.sessionId, facts());
  if (sent.kind !== "ok")
    fail(`pointer report failed: ${describeFailure(sent)}`);
}
