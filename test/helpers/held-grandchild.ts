import { once } from "node:events";
import net from "node:net";
import { addAbortSignal } from "node:stream";
import { text } from "node:stream/consumers";

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
  const writer = `
    const peer = ${connect};
    peer.once("data", () => {
      const writes = [1, 2].map(fd => {
        try {
          require("node:fs").writeSync(fd, "x");
          return "writable";
        } catch (error) {
          return error.code;
        }
      });
      peer.end(writes.join(" "));
    });`;
  const connected = async (signal: AbortSignal): Promise<net.Socket> =>
    peer ?? (await once(server, "connection", { signal }))[0];
  return {
    port,
    address,
    // Waiting makes the connected process a grandchild even when the shell
    // would otherwise exec its final command.
    command: `${shellWord(process.execPath)} -e ${shellWord(connect)} & wait`,
    // The launcher owns the parent. Its referenced child keeps it running
    // until abort. detached places the writer in its own group before exec.
    escapedWriter: {
      bin: process.execPath,
      args: [
        "-e",
        `require("node:child_process").spawn(process.execPath, ["-e", process.argv[1]], { detached: true, stdio: "inherit" })`,
        writer,
      ],
    },
    connected: () => untilTestEnds(connected, "the grandchild to connect"),
    writes: () =>
      untilTestEnds(async (signal) => {
        const socket = await connected(signal);
        const result = text(addAbortSignal(signal, socket));
        socket.end("?");
        return result;
      }, "the escaped writer to report its stdout and stderr writes"),
    started: async () => {
      const child = await untilTestEnds(connected, "the grandchild to connect");
      // Opening the gate frees a shell waiting to read its launch input.
      return () => child.end();
    },
    ended: () =>
      untilTestEnds(async (signal) => {
        const child = await connected(signal);
        if (!child.closed) await once(child, "close", { signal });
      }, "the grandchild to close its connection"),
    async [Symbol.asyncDispose]() {
      peer?.destroy();
      await server[Symbol.asyncDispose]();
    },
  };
}
