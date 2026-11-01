import { duplexPair, type Duplex } from "node:stream";

// A connection's two ends in memory: `daemonEnd` is what the net server hands
// the daemon, and `client` is the peer.
// A bare pair carries a half-close but not a hang-up: a destroyed side says
// nothing to the other, whose `end` callback then never settles, where a
// socket's vanished peer settles it with an error. So each end's close destroys
// the other, and a client's `destroy` is a hang-up. The client closes on the
// daemon's end as a socket from `net.connect` does; the daemon's side is left
// as the pair builds it, so what it does at a half-close is the connection's.
export function memoryConnection(): { daemonEnd: Duplex; client: Duplex } {
  const [daemonEnd, client] = duplexPair();
  client.allowHalfOpen = false;
  daemonEnd.once("close", () => client.destroy());
  client.once("close", () => daemonEnd.destroy());
  return { daemonEnd, client };
}
