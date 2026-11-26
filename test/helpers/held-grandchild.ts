import { once } from "node:events";
import net from "node:net";

import { shellWord } from "../../src/shell-word";
import { untilTestEnds } from "./test-end";

// [LAW:no-ambient-temporal-coupling] The fixture holds the accepted socket.
// A grandchild connects when ready and can observe the test worker exiting as EOF.
export async function heldGrandchild() {
  let peer: net.Socket | undefined;
  const server = net.createServer((child) => {
    peer = child;
    server.close();
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const { port, address } = server.address() as net.AddressInfo;
  const connect = `require("node:net").connect(${port}, ${JSON.stringify(address)}).resume()`;
  const connected = async (signal: AbortSignal): Promise<net.Socket> =>
    peer ?? (await once(server, "connection", { signal }))[0];
  return {
    port,
    address,
    // The shell waits even if it would otherwise exec a final command.
    command: `${shellWord(process.execPath)} -e ${shellWord(connect)} & wait`,
    connected: () => untilTestEnds(connected),
    started: async () => {
      const child = await untilTestEnds(connected);
      return () => child.end();
    },
    ended: () =>
      untilTestEnds(async (signal) => {
        const child = await connected(signal);
        if (!child.closed) await once(child, "close", { signal });
      }),
    async [Symbol.asyncDispose]() {
      peer?.destroy();
      await server[Symbol.asyncDispose]();
    },
  };
}
