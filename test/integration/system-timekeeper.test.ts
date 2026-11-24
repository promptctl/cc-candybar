import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { systemTimekeeper } from "../helpers/system-clock";
import { timekeeperContract } from "../contract/timekeeper.contract";

timekeeperContract("the system timekeeper", () => ({
  clock: systemTimekeeper,
  settle: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}));

describe("the system timekeeper", () => {
  // [LAW:no-ambient-temporal-coupling] The ordering `defer` promises, on the
  // machine's loop: a timer due while the loop was held runs first, then the
  // input that arrived meanwhile is read, then the run it deferred. The
  // daemon's request backstop relies on it (src/daemon/connection.ts).
  test("a run a timer defers comes after the input already waiting on a socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-timekeeper-"));
    const ran: string[] = [];
    const heard = Promise.withResolvers<net.Socket>();
    const server = net.createServer((conn) => {
      conn.on("data", () => ran.push("input"));
      heard.resolve(conn);
    });
    const sock = path.join(dir, "s");
    await new Promise<void>((listening) => server.listen(sock, listening));
    const client = net.connect(sock);
    const conn = await heard.promise;
    const deferred = Promise.withResolvers<void>();
    try {
      systemTimekeeper.after("test task", 1, () => {
        ran.push("timer");
        systemTimekeeper.defer("test task", () => {
          ran.push("deferred");
          deferred.resolve();
        });
      });
      client.write("x");
      // The loop is held past the timer's moment with the input unread.
      const held = systemTimekeeper.monotonic();
      while (systemTimekeeper.monotonic() - held < 10);
      await deferred.promise;
      expect(ran).toEqual(["timer", "input", "deferred"]);
    } finally {
      client.destroy();
      conn.destroy();
      await new Promise((closed) => server.close(closed));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a timer set to leave the process alone does not hold the loop", () => {
    const set = jest.spyOn(globalThis, "setTimeout");
    const clear = systemTimekeeper.after("test task", 60_000, () => undefined, {
      unref: true,
    });
    const held = systemTimekeeper.after("test task", 60_000, () => undefined);
    const [unref, ref] = set.mock.results.map(
      (r) => r.value as NodeJS.Timeout,
    );
    set.mockRestore();
    clear();
    held();
    expect(unref!.hasRef()).toBe(false);
    expect(ref!.hasRef()).toBe(true);
  });
});
