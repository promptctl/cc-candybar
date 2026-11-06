import type { Duplex } from "node:stream";
import type { Dialer } from "../../src/dial/dialer";

// What a test of a Dialer needs from its subject: a dialer, and a daemon's side
// it can stand up at a path.
export interface Subject {
  readonly dialer: Dialer;
  // A path nothing has bound.
  readonly path: () => string;
  // Accepts every dial of the path, handing `onConnection` the daemon's end.
  readonly listen: (
    sockPath: string,
    onConnection: (daemonEnd: Duplex) => void,
  ) => Promise<() => Promise<void>>;
}

const closed = (end: Duplex): Promise<void> =>
  end.destroyed
    ? Promise.resolve()
    : new Promise((r) => end.once("close", () => r()));

const read = (end: Duplex): Promise<string> =>
  new Promise((r) => end.once("data", (chunk: Buffer) => r(chunk.toString())));

// [LAW:one-source-of-truth] What a Dialer promises, stated once. The fake
// (test/unit/dialer-fake.test.ts) and the socket
// (test/integration/system-dialer.test.ts) both run it, so a client decision a
// unit test makes over the fake holds on the machine.
export function dialerContract(name: string, make: () => Subject): void {
  describe(`${name} is a Dialer`, () => {
    test("a path nothing listens on is unreachable", async () => {
      const { dialer, path } = make();
      const dialed = await dialer.dial(path()).settled;
      expect(dialed).toMatchObject({
        ok: false,
        failure: { cause: "unreachable" },
      });
    });

    test("a dial of a listener connects, and bytes cross both ways", async () => {
      const { dialer, path, listen } = make();
      const sockPath = path();
      const daemonEnds: Duplex[] = [];
      const stop = await listen(sockPath, (end) => daemonEnds.push(end));
      try {
        const dialed = await dialer.dial(sockPath).settled;
        if (!dialed.ok) throw new Error(dialed.failure.message);
        const [daemonEnd] = daemonEnds;
        const heard = read(daemonEnd!);
        dialed.conn.write("ping");
        expect(await heard).toBe("ping");
        const answered = read(dialed.conn);
        daemonEnd!.write("pong");
        expect(await answered).toBe("pong");
        dialed.conn.destroy();
        await closed(daemonEnd!);
      } finally {
        await stop();
      }
    });

    test("the daemon's hang-up closes the client's end", async () => {
      const { dialer, path, listen } = make();
      const sockPath = path();
      const stop = await listen(sockPath, (end) => end.destroy());
      try {
        const dialed = await dialer.dial(sockPath).settled;
        if (!dialed.ok) throw new Error(dialed.failure.message);
        dialed.conn.resume();
        await closed(dialed.conn);
      } finally {
        await stop();
      }
    });

    test("a stopped listener is unreachable again", async () => {
      const { dialer, path, listen } = make();
      const sockPath = path();
      const stop = await listen(sockPath, (end) => end.destroy());
      await stop();
      const dialed = await dialer.dial(sockPath).settled;
      expect(dialed).toMatchObject({
        ok: false,
        failure: { cause: "unreachable" },
      });
    });

    test("a dial abandoned before it lands hands the listener nothing it keeps", async () => {
      const { dialer, path, listen } = make();
      const sockPath = path();
      const daemonEnds: Duplex[] = [];
      const stop = await listen(sockPath, (end) => {
        end.resume();
        daemonEnds.push(end);
      });
      try {
        dialer.dial(sockPath).abandon();
        // A later dial lands after any the abandoned one could have made.
        const next = await dialer.dial(sockPath).settled;
        if (!next.ok) throw new Error(next.failure.message);
        await Promise.all(daemonEnds.slice(0, -1).map(closed));
        next.conn.destroy();
      } finally {
        await stop();
      }
    });
  });
}
