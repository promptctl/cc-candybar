// [LAW:single-enforcer] Whether a click's client has left, by the click's id.
// A click crosses to its renderer as data, so what its waits ask about its
// client is asked of the host, which answers from the click's own connection:
// the backstop that answered it TIMEOUT, or the socket its client closed. The
// host holds each click here for as long as its turn runs.

import type { RequestId } from "../renderer/interface.js";

// A click as its connection knows it: the request it arrived in, and whether
// its client has left.
export interface ClickInFlight {
  readonly id: RequestId;
  readonly gone: () => boolean;
}

export class ClicksInFlight {
  private readonly held = new Map<RequestId, () => boolean>();

  hold({ id, gone }: ClickInFlight): Disposable {
    this.held.set(id, gone);
    return { [Symbol.dispose]: () => void this.held.delete(id) };
  }

  gone(click: RequestId): boolean {
    const gone = this.held.get(click);
    // [LAW:no-silent-failure] Only a click's own turn asks, and the host holds
    // the click through it: any other ask is a bug.
    if (gone === undefined) throw new Error(`click ${click} is not in flight`);
    return gone();
  }
}
