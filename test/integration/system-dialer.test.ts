import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { systemDialer } from "../../src/dial/system-dialer";
import { dialerContract } from "../contract/dialer.contract";

// The daemon's side here is a real unix socket, the one place a test listens
// on one for a client: every other client test listens on the fake.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dialer-contract-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

const listen = (
  sockPath: string,
  onConnection: (end: net.Socket) => void,
): Promise<() => Promise<void>> =>
  new Promise((resolve, reject) => {
    const server = net.createServer(onConnection);
    server
      .once("error", reject)
      .listen(sockPath, () =>
        resolve(() => new Promise<void>((r) => server.close(() => r()))),
      );
  });

dialerContract("the system dialer", () => ({
  dialer: systemDialer,
  path: () => path.join(root, `s${n++}.sock`),
  listen,
}));

describe("the system dialer", () => {
  // The kernel facts a daemon's lease relies on, read through the port: a
  // plain file left where a socket was is no daemon.
  test("a plain file at the path is unreachable", async () => {
    const sockPath = path.join(root, "stale.sock");
    fs.writeFileSync(sockPath, "");
    const dialed = await systemDialer.dial(sockPath).settled;
    expect(dialed).toMatchObject({
      ok: false,
      failure: { cause: "unreachable" },
    });
  });
});
