import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// [LAW:verifiable-goals] The kernel facts the daemon's bind-based singleton
// relies on, on a real unix socket: a second listener on a bound path gets
// EADDRINUSE, and so does one on a plain file left at the path, which an
// unlink clears for a fresh bind. The daemon's arbitration reads the
// socket-derived pid lease (daemon-socket-lease.test.ts); these pin only the
// mechanics under it. A dial of such a file is the dialer's
// (system-dialer.test.ts).

const root = fs.mkdtempSync(path.join(os.tmpdir(), "socket-bind-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const bind = (sockPath: string): Promise<net.Server> =>
  new Promise((resolve, reject) => {
    const server = net.createServer((sock) => sock.end());
    server.once("error", reject).listen(sockPath, () => resolve(server));
  });

const close = (server: net.Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

test("a second bind on a bound socket path receives EADDRINUSE", async () => {
  const sockPath = path.join(root, "bound.sock");
  const first = await bind(sockPath);
  try {
    await expect(bind(sockPath)).rejects.toMatchObject({ code: "EADDRINUSE" });
  } finally {
    await close(first);
  }
});

test("a plain file at the path refuses a bind until it is unlinked", async () => {
  const sockPath = path.join(root, "stale.sock");
  fs.writeFileSync(sockPath, "");
  await expect(bind(sockPath)).rejects.toMatchObject({ code: "EADDRINUSE" });
  // What handleAddressInUse does.
  fs.unlinkSync(sockPath);
  const server = await bind(sockPath);
  try {
    expect(fs.existsSync(sockPath)).toBe(true);
  } finally {
    await close(server);
  }
});
