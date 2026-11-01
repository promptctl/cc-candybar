// What Claude Code itself waits for: the client process, from its spawn to its
// exit, against a daemon that has the session settled. This is the number a
// user feels, and the only one that includes starting a process.
//
// Two floors sit beside the clients: a process that does nothing, and a node
// process that does nothing. A client's time is read against them, since the
// machine's cost of starting a process is not the client's.

import { spawn } from "node:child_process";
import path from "node:path";

import { BUNDLED_CLIENT_SHIM, REPO, nativeClient } from "../environment.js";
import { measured, skipped, type Benchmark, type Outcome } from "../types.js";
import { inWorld } from "../world.js";
import { repeat, WARMUP } from "../measure.js";

const COLUMNS = 120;
const CALLS = 100;

interface Ran {
  readonly stdout: string;
  readonly code: number | null;
}

function run(
  command: string,
  args: readonly string[],
  // Null for a process that is given nothing to read.
  options: { env: NodeJS.ProcessEnv; cwd: string; stdin: string | null },
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      cwd: options.cwd,
      stdio: [options.stdin === null ? "ignore" : "pipe", "pipe", "ignore"],
    });
    let stdout = "";
    // stdio[1] is always a pipe, which the spawn's union type cannot say.
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => (stdout += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, code }));
    // A client that stops reading its input is a failed run, said with its
    // cause, not an unhandled stream error.
    child.stdin?.once("error", reject);
    child.stdin?.end(options.stdin);
  });
}

// What a spawn of `command` costs, wall time from spawn to the exit.
const spawned = async (
  samples: number,
  once: () => Promise<void>,
): Promise<Outcome> =>
  measured([{ name: "wall", samples: await repeat(samples, once) }]);

const floor = (
  id: string,
  about: string,
  command: string,
  args: readonly string[],
): Benchmark => ({
  id,
  group: "client",
  about,
  samples: CALLS,
  run: (plan) =>
    spawned(plan.samples, async () => {
      const ran = await run(command, args, { env: {}, cwd: "/", stdin: null });
      if (ran.code !== 0) throw new Error(`${command} exited ${ran.code}`);
    }),
});

// A client process rendering a settled session: the hook JSON on stdin, the
// bar on stdout, exit 0.
const client = (
  id: string,
  about: string,
  // Null when the machine has no such client, with the reason.
  command: () =>
    | {
        bin: string;
        args: string[];
        facts: Record<string, string>;
        builtFromThisSource?: boolean;
      }
    | string,
): Benchmark => ({
  id,
  group: "client",
  about,
  samples: CALLS,
  async run(plan) {
    const found = command();
    if (typeof found === "string") return skipped(found);
    return inWorld(async (world) => {
      const session = world.session(
        "a",
        { files: 200, commits: 20, modified: 8, untracked: 4 },
        1_700,
      );
      await world.settle(session, COLUMNS);
      let n = 100;
      const before = (await world.stats()).requests.total;
      const ms = await repeat(plan.samples, async () => {
        const ran = await run(found.bin, found.args, {
          env: world.clientEnv(COLUMNS),
          cwd: session.cwd,
          stdin: JSON.stringify(world.hookData(session, n++)),
        });
        // [LAW:no-silent-failure] A client that exited non-zero, or printed no
        // bar, is not a fast client.
        if (ran.code !== 0 || !/\S/.test(ran.stdout)) {
          throw new Error(
            `${id}: the client exited ${ran.code} and printed ${JSON.stringify(ran.stdout.slice(0, 200))}` +
              (found.builtFromThisSource === false
                ? " (this binary was not built from this source: just install-rust)"
                : ""),
          );
        }
      });
      // [LAW:no-silent-failure] A client that printed a fallback strip without
      // reaching the daemon exits 0 too: the daemon's own count of requests is
      // what says every sample was a tick it answered.
      const answered = (await world.stats()).requests.total - before;
      const spawns = plan.samples + WARMUP;
      if (answered < spawns) {
        throw new Error(
          `${id}: ${spawns} runs reached the daemon as ${answered} requests`,
        );
      }
      return measured([{ name: "wall", samples: ms }], found.facts);
    });
  },
});

export const CLIENTS: readonly Benchmark[] = [
  floor(
    "client.floor.exec",
    "a process that exits at once (`true`): the floor of any spawn",
    "true",
    [],
  ),
  floor(
    "client.floor.node",
    "a node process that exits at once: the floor of a client that is node",
    process.execPath,
    ["-e", ""],
  ),
  client(
    "client.native",
    "the shipped native client, spawned as Claude Code spawns it, drawing a settled session",
    () => {
      const native = nativeClient();
      return native === null
        ? "no native client is built (just install-rust stages one)"
        : {
            bin: path.join(REPO, native.path),
            args: [],
            facts: { builtFromThisSource: String(native.builtFromThisSource) },
            builtFromThisSource: native.builtFromThisSource,
          };
    },
  ),
  client(
    "client.node",
    "the node client (what runs where no native client is staged), spawned as Claude Code spawns it, drawing a settled session",
    () => ({ bin: process.execPath, args: [BUNDLED_CLIENT_SHIM], facts: {} }),
  ),
];
