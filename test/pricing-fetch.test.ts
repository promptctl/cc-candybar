// [LAW:verifiable-goals] The price table's network edge against a real HTTP
// server on loopback: what it answers, and that no connection of its own
// outlives the answer or the abort.

import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { remotePricing } from "../src/daemon/cache/pricing-fetch";
import { failed, ok } from "../src/utils/outcome";

const servers: http.Server[] = [];

// A server answering every request with `respond`, and a promise per
// connection it accepts that settles when that connection closes. A
// keep-alive connection would outlast every case: only the client can end it.
async function serve(respond: http.RequestListener) {
  const server = http.createServer(respond);
  server.keepAliveTimeout = 10 * 60_000;
  const closed: Array<Promise<void>> = [];
  server.on("connection", (socket: Socket) => {
    closed.push(
      new Promise((resolve) => socket.once("close", () => resolve())),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return {
    fetch: remotePricing(
      http.get,
      new URL(`http://127.0.0.1:${port}/pricing.json`),
    ),
    closed,
  };
}

const signal = () => new AbortController().signal;

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe("the pricing fetch", () => {
  test("answers the body whole, and its connection closes once it has", async () => {
    const body = JSON.stringify({ model: { input: 1 } });
    const { fetch, closed } = await serve((_, res) => res.end(body));

    expect(await fetch(signal())).toEqual(ok(body));
    await Promise.all(closed);
  });

  test("a character that straddles two chunks of the body arrives whole", async () => {
    const body = Buffer.from(JSON.stringify({ name: "Modèle" }));
    const inside = body.indexOf(0xc3) + 1;
    const { fetch } = await serve((_, res) => {
      // No length: each write is a chunk of its own on the wire.
      res.writeHead(200);
      res.write(body.subarray(0, inside));
      res.end(body.subarray(inside));
    });

    expect(await fetch(signal())).toEqual(ok(body.toString("utf8")));
  });

  test("a body past the byte limit is refused and its connection ended", async () => {
    // Under the limit in characters, over it in bytes.
    const body = JSON.stringify({ name: "é".repeat(600 * 1024) });
    const { fetch, closed } = await serve((_, res) => res.end(body));

    expect(await fetch(signal())).toEqual(
      failed("the body passed 1048576 bytes", "read"),
    );
    await Promise.all(closed);
  });

  test("an answer other than 200 is refused and its connection ended", async () => {
    const { fetch, closed } = await serve((_, res) => {
      res.writeHead(404);
      res.end("gone");
    });

    expect(await fetch(signal())).toEqual(failed("HTTP 404 Not Found", "read"));
    await Promise.all(closed);
  });

  test("an abort while the body is coming ends the fetch and its connection", async () => {
    let responding!: () => void;
    const started = new Promise<void>((resolve) => (responding = resolve));
    // Half a body, and then nothing: only the abort can end this.
    const { fetch, closed } = await serve((_, res) => {
      res.writeHead(200);
      res.write("{");
      responding();
    });
    const abort = new AbortController();

    const fetching = fetch(abort.signal);
    await started;
    abort.abort();

    expect(await fetching).toMatchObject({ kind: "failed", failedAt: "read" });
    await Promise.all(closed);
  });

  test("a server that is not there is a failure, not a throw", async () => {
    const { fetch } = await serve(() => {});
    const server = servers.pop()!;
    await new Promise((resolve) => server.close(resolve));

    expect(await fetch(signal())).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("ECONNREFUSED"),
    });
  });
});
