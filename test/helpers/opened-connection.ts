// A client's end of a connection to a daemon, read as the responses it is sent.
// Shared by the cases over a stand-in daemon and the cases over one built in the
// worker, so both read a connection the same way.

import {
  encodeFrame,
  makeFrameReader,
  type Request,
  type Response,
} from "../../src/daemon/protocol";
import type { memoryConnection } from "../../src/dial/dialer-fake";

export interface Opened {
  readonly client: ReturnType<typeof memoryConnection>["client"];
  readonly received: Response[];
  send(req: Request): void;
  // Whether the daemon's side ended the connection.
  ended(): boolean;
}

export const openedOn = (client: Opened["client"]): Opened => {
  const received: Response[] = [];
  let over = false;
  client.on(
    "data",
    makeFrameReader(
      (frame) => received.push(frame as Response),
      (err) => {
        throw err;
      },
    ),
  );
  client.on("end", () => (over = true));
  return {
    client,
    received,
    send: (req) => client.write(encodeFrame(req)),
    ended: () => over,
  };
};
