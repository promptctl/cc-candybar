import { once } from "node:events";
import net from "node:net";

import { until } from "../../scripts/lib/until";
import { shellWord } from "../../src/shell-word";

// A shell grandchild holds a connection to this test until its process group
// dies. Its connection proves both startup and exit. Disposing the fixture (or
// losing the test worker) also releases an orphan, without signalling a PID.
export async function heldGrandchild() {
  let peer: net.Socket | undefined;
  let ended = false;
  const server = net.createServer((child) => {
    peer = child;
    child.once("close", () => {
      ended = true;
    });
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const { port } = server.address() as net.AddressInfo;
  const connect = `require("node:net").connect(${port}, "127.0.0.1").resume()`;
  return {
    // Waiting in the shell makes the connected process its grandchild from
    // the launcher's perspective, even on shells that exec a final command.
    command: `${shellWord(process.execPath)} -e ${shellWord(connect)} & wait`,
    started: () => until(() => peer !== undefined, "the grandchild connecting"),
    ended: () => until(() => ended, "the grandchild disconnecting"),
    async [Symbol.asyncDispose]() {
      peer?.destroy();
      await server[Symbol.asyncDispose]();
    },
  };
}
