import { writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import { until } from "./until";

// Reads the tmux session name, which the payload awaits from a `tmux` spawn
// (src/segments/tmux.ts): the stub below.
export const HELD_CONFIG = `{ segments: { mark: { template: '{{ .tmux.session }}' } }, root: { h: ['mark'] } }`;

// [LAW:no-ambient-temporal-coupling] The `tmux` on the daemon's PATH: it
// connects to the gate beside it, a unix socket the test listens on, and
// answers only once the test writes a line into it. Its connection is its
// asking, so `asked` means "reading": the test opens the gate after the
// client has been answered, so the render provably outlives its deadline, an
// ordering the test owns, not a bet on how slow a render is. Only a render
// whose client reports a tmux pane runs it.
//
// The stub's life is the connection's. One the daemon launched dies with the
// daemon too, by the launcher's lifeline, but a test of the gate starts one
// itself, which only its gate ends. Closing the gate, which afterAll does and
// the kernel does when the worker dies, ends the stub's read, and it exits 1; a
// stub started once the gate is closed finds nothing listening and exits at
// once. So a run that ends before its gate opens, however it ends, leaves no
// stub behind. The stub runs on the worker's own node, so it needs nothing
// from the daemon's PATH, and it says back through the gate that it heard.
const STUB_TMUX = [
  `#!${process.execPath}`,
  `const gate = require("node:net").connect(require("node:path").join(__dirname, "gate"));`,
  `process.exitCode = 1;`,
  `gate.once("data", () => { process.exitCode = 0; process.stdout.write("held\\n"); gate.end("held\\n"); });`,
  `gate.on("close", () => process.exitCode && process.stderr.write("the gate closed before it opened\\n"));`,
  `gate.on("error", (err) => process.stderr.write(err.message + "\\n"));`,
].join("\n");

export interface TmuxStub {
  // Resolves once the nth stub to run has connected, counting from 1.
  asked(n: number): Promise<void>;
  // Lets the nth stub answer, resolving once it says it heard. Rejects,
  // naming it, when it hung up first.
  open(n: number): Promise<void>;
  // Ends every stub still waiting.
  close(): Promise<void>;
}

// One stub's connection, and how it ended if it hung up.
interface Ask {
  socket: net.Socket;
  hungUp: string | null;
}

// A `tmux` in `dir` and the gate it waits on.
export async function tmuxStub(dir: string): Promise<TmuxStub> {
  writeFileSync(path.join(dir, "tmux"), STUB_TMUX, { mode: 0o755 });
  // [LAW:no-silent-failure] A stub that hangs up before its gate opens says
  // how, for the open that finds it gone.
  const asks: Ask[] = [];
  const server = net.createServer((socket) => {
    const ask: Ask = { socket, hungUp: null };
    socket.on("error", (err) => (ask.hungUp = err.message));
    socket.on("close", () => (ask.hungUp ??= "hung up"));
    asks.push(ask);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject).listen(path.join(dir, "gate"), resolve);
  });
  return {
    asked: (n) => until(() => asks.length >= n, `tmux stub #${n} asking`),
    open: (n) =>
      new Promise((resolve, reject) => {
        const ask = asks[n - 1];
        if (ask === undefined)
          return reject(new Error(`tmux stub #${n} never asked`));
        const gone = () =>
          reject(
            new Error(`tmux stub #${n} ${ask.hungUp} before its gate opened`),
          );
        if (ask.hungUp !== null) return gone();
        // A write lands in the kernel whether or not the stub is alive to
        // read it; only the stub's answer back says it heard.
        ask.socket.once("data", () => resolve()).once("close", gone);
        ask.socket.write("open\n");
      }),
    close: () =>
      new Promise((resolve, reject) => {
        for (const { socket } of asks) socket.destroy();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
