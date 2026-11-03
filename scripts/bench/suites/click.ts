// What a `cc-candybar://` click costs on this Mac, Launch Services included:
// from `open` being asked to the daemon's click event for that link.
//
// The other suites own a daemon of their own and touch nothing the developer
// runs. A click cannot be measured that way: Launch Services hands it to
// whichever app claims the scheme, and that app writes to the default socket.
// So this suite measures the machine as it stands, the registered handler and
// the live daemon, and is skipped where either is absent. Each click carries a
// verb the daemon does not know (`bench-<run>-<n>`), so it changes nothing and
// still writes its event, as a bad request, which is the event this reads.
//
// Two series per click. `open` returning says Launch Services delivered the
// URL to the app; the daemon's event, less what the daemon itself spent
// (`queued`, `took`), says when the click reached the socket. A cold click is
// one the handler app had to be started for, so the forwarder is quit before
// each; a warm one finds it resident. The retired AppleScript applet exits
// after every click, so under it the two cases measure the same thing, and
// the `via` fact says which handler answered.
//
// [LAW:no-silent-failure] A click whose event never appears fails the run with
// the link that was lost, and the handler that answered is read off the event
// (`via=`), never assumed from what was meant to be registered.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";

import { URL_SCHEME } from "../../../src/click/wire.js";
import { logLines } from "../../../src/daemon/log.js";
import { defaultSocketPath, logPath } from "../../../src/daemon/paths.js";
import { processWorld } from "../../../src/host.js";
import { APP_NAME } from "../../../src/install/index.js";
import { sleep } from "../measure.js";
import {
  measured,
  skipped,
  type Benchmark,
  type Outcome,
  type Plan,
} from "../types.js";

const EVENT_WAIT_MS = 10_000;
const POLL_MS = 20;
const QUIT_WAIT_MS = 3_000;

interface Click {
  readonly openMs: number;
  readonly arrivalMs: number;
  readonly via: string;
}

function field(line: string, key: string): string {
  const m = new RegExp(`(?:^| )${key}=("(?:[^"\\\\]|\\\\.)*"|\\S+)`).exec(line);
  if (m === null) throw new Error(`no ${key} on event: ${line}`);
  return m[1]!;
}

function msOf(line: string, key: string): number {
  const v = field(line, key);
  if (!v.endsWith("ms"))
    throw new Error(`${key}=${v} is not a duration: ${line}`);
  return Number(v.slice(0, -2));
}

// `killall` exits 1 when nothing matched, the other legal state before a cold
// click. The quit must have landed before the click, or Launch Services
// delivers to the instance on its way out.
async function quitForwarder(): Promise<void> {
  const r = spawnSync("/usr/bin/killall", [APP_NAME], { encoding: "utf8" });
  if (r.status !== 0 && r.status !== 1)
    throw new Error(`killall ${APP_NAME}: ${r.stderr}`);
  const until = Date.now() + QUIT_WAIT_MS;
  while (spawnSync("/usr/bin/pgrep", ["-x", APP_NAME]).status === 0) {
    if (Date.now() > until)
      throw new Error(
        `${APP_NAME} still running ${QUIT_WAIT_MS}ms after killall`,
      );
    await sleep(POLL_MS);
  }
}

async function click(log: string, verb: string): Promise<Click> {
  const url = `${URL_SCHEME}://${verb}/1`;
  const t0 = Date.now();
  execFileSync("/usr/bin/open", ["-g", url], { stdio: "pipe" });
  const openMs = Date.now() - t0;
  const until = t0 + EVENT_WAIT_MS;
  for (;;) {
    const line = logLines(log).find((l) =>
      l.includes(`unknown click verb: ${verb}`),
    );
    if (line !== undefined) {
      const at = Date.parse(line.slice(0, 24));
      return {
        openMs,
        arrivalMs: at - msOf(line, "queued") - msOf(line, "took") - t0,
        via: field(line, "via"),
      };
    }
    if (Date.now() > until)
      throw new Error(`no click event for ${url} within ${EVENT_WAIT_MS}ms`);
    await sleep(POLL_MS);
  }
}

// Why this machine cannot be measured, or null when it can: the daemon's
// default socket is live and some app claims the scheme. `open` with no
// handler says so and exits non-zero.
function cannotMeasure(socket: string): string | null {
  if (process.platform !== "darwin") return "the scheme is macOS-only";
  if (!fs.existsSync(socket))
    return `no daemon on the default socket ${socket}`;
  const probe = spawnSync(
    "/usr/bin/open",
    ["-g", `${URL_SCHEME}://bench-probe/1`],
    {
      encoding: "utf8",
    },
  );
  if (probe.status !== 0)
    return `no handler for ${URL_SCHEME}://: ${probe.stderr.trim()}`;
  return null;
}

async function clicks(
  plan: Plan,
  before: () => Promise<void>,
): Promise<Outcome> {
  const { host } = processWorld();
  const reason = cannotMeasure(defaultSocketPath());
  if (reason !== null) return skipped(reason);
  const log = logPath(host);
  const run = Date.now().toString(36);
  const samples: Click[] = [];
  for (let i = 0; i < plan.samples; i++) {
    await before();
    samples.push(await click(log, `bench-${run}-${i}`));
  }
  return measured(
    [
      { name: "open-returned", samples: samples.map((c) => c.openMs) },
      { name: "daemon-arrival", samples: samples.map((c) => c.arrivalMs) },
    ],
    { via: [...new Set(samples.map((c) => c.via))].join(",") },
  );
}

export const CLICKS: readonly Benchmark[] = [
  {
    id: "click.cold",
    group: "click",
    about: "a click that starts the handler app, to the daemon's event",
    samples: 5,
    run: (plan) => clicks(plan, quitForwarder),
  },
  {
    id: "click.warm",
    group: "click",
    about: "a click with the handler app resident, to the daemon's event",
    samples: 10,
    run: (plan) => clicks(plan, async () => {}),
  },
];
