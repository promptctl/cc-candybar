import { once } from "node:events";
import net from "node:net";

import { shellWord } from "../../src/shell-word";
import { untilTestEnds } from "./test-end";

// [LAW:no-ambient-temporal-coupling] The grandchild owns the peer. Its
// connection proves readiness, and EOF releases it if the test worker exits.
export async function grandchildConnection() {
  let peer: net.Socket | undefined;
  const server = net.createServer((child) => {
    peer = child;
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    connected: () =>
      untilTestEnds(
        async (signal): Promise<net.Socket> =>
          peer ?? (await once(server, "connection", { signal }))[0],
      ),
    ended: () =>
      untilTestEnds(async (signal) => {
        if (!peer) throw new Error("the grandchild has not connected");
        if (!peer.closed) await once(peer, "close", { signal });
      }),
    async [Symbol.asyncDispose]() {
      peer?.destroy();
      await server[Symbol.asyncDispose]();
    },
  };
}

export async function heldGrandchild() {
  const connection = await grandchildConnection();
  const connect = `require("node:net").connect(${connection.port}, "127.0.0.1").resume()`;
  return {
    // The shell waits even if it would otherwise exec a final command.
    command: `${shellWord(process.execPath)} -e ${shellWord(connect)} & wait`,
    started: async () => {
      const peer = await connection.connected();
      return () => peer.end();
    },
    ended: connection.ended,
    [Symbol.asyncDispose]: connection[Symbol.asyncDispose],
  };
}
