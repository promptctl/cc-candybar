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
// URL to the app, and the series carries the spawn of `open` itself, so the
// client group's exec floor is its floor; the daemon's event, less what the
// daemon itself spent (`queued`, `took`), says when the click reached the
// socket. A cold click is one the handler app had to be started for, so the
// forwarder is quit before each; a warm one finds it resident. The retired
// AppleScript applet exits after every click, so under it the two cases
// measure the same thing, and the `via` fact says which handler answered.
//
// The daemon on the default socket was spawned by some shell, and this one may
// not share its state directory: then every click lands and this reads another
// log. The daemon does not say where it logs, so a lost event names the log
// read, and a socket file is not taken as a daemon: one that died without
// unlinking leaves it, and a click into it is a notification on the user's
// screen. A round trip proves the daemon.
//
// [LAW:no-silent-failure] A click whose event never appears fails the run with
// the link that was lost and the log searched, and the handler that answered
// is read off the event (`via=`), never assumed from what was meant to be
// registered.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";

import { APP_NAME, URL_SCHEME } from "../../../src/click/wire.js";
import { fetchStats } from "../../../src/daemon/client-stats.js";
import { describeFailure } from "../../../src/daemon/client-transport.js";
import { logPath } from "../../../src/daemon/paths.js";
import { processWorld } from "../../../src/host.js";
import { fieldOf, fieldsOf } from "../../../src/utils/logfmt.js";
import { atOf, msOf } from "../log-event.js";
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

// Where the log stands: its size, and the inode that tells one generation
// from the next. A log not yet written is empty under no inode.
interface Mark {
  readonly size: number;
  readonly ino: number | null;
}

function markOf(file: string): Mark {
  try {
    const st = fs.statSync(file);
    return { size: st.size, ino: st.ino };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { size: 0, ino: null };
    throw e;
  }
}

function readFrom(file: string, offset: number): string {
  const size = markOf(file).size;
  if (size <= offset) return "";
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// The log's whole lines written since it stood at `mark`. The event can only
// be past where the file stood at the click, and the older generations cannot
// hold a verb minted this run, so nothing before the mark is read. A log whose
// inode changed rotated under the wait, and the lines since are the end of the
// rotated file and all of the new one; the inode, not the size, says so,
// because a busy daemon refills a fresh log past the mark within the wait.
function linesSince(log: string, mark: Mark): string[] {
  const text =
    markOf(log).ino === mark.ino
      ? readFrom(log, mark.size)
      : readFrom(`${log}.1`, mark.size) + readFrom(log, 0);
  return text.split("\n").slice(0, -1);
}

async function click(log: string, verb: string): Promise<Click> {
  const url = `${URL_SCHEME}://${verb}/1`;
  const problem = `unknown click verb: ${verb}`;
  const mark = markOf(log);
  const t0 = Date.now();
  execFileSync("/usr/bin/open", ["-g", url], { stdio: "pipe" });
  const openMs = Date.now() - t0;
  const until = t0 + EVENT_WAIT_MS;
  for (;;) {
    const line = linesSince(log, mark).find(
      (l) => fieldsOf(l).get("problems") === problem,
    );
    if (line !== undefined) {
      return {
        openMs,
        arrivalMs: atOf(line) - msOf(line, "queued") - msOf(line, "took") - t0,
        via: fieldOf(line, "via"),
      };
    }
    if (Date.now() > until)
      throw new Error(
        `no click event for ${url} in ${log} within ${EVENT_WAIT_MS}ms`,
      );
    await sleep(POLL_MS);
  }
}

// Why this machine cannot be measured, or null when it can: a daemon answers
// on the default socket and some app claims the scheme. The round trip goes
// where a click goes, the default socket, whatever this shell's override
// says. `open` with no handler says so and exits non-zero; with one, the
// probe is a click on the live daemon, so it is asked once a process, not
// once a benchmark.
let verdict: Promise<string | null> | null = null;

function cannotMeasure(): Promise<string | null> {
  verdict ??= (async () => {
    if (process.platform !== "darwin") return "the scheme is macOS-only";
    const { host, clock } = processWorld();
    const { CC_CANDYBAR_SOCKET: _override, ...env } = host.env;
    const stats = await fetchStats({ host: { ...host, env }, clock });
    if (stats.kind !== "ok")
      return `no daemon on the default socket: ${describeFailure(stats)}`;
    const probe = spawnSync(
      "/usr/bin/open",
      ["-g", `${URL_SCHEME}://bench-probe/1`],
      { encoding: "utf8" },
    );
    if (probe.status !== 0)
      return `no handler for ${URL_SCHEME}://: ${probe.stderr.trim()}`;
    return null;
  })();
  return verdict;
}

async function clicks(
  plan: Plan,
  before: () => Promise<void>,
): Promise<Outcome> {
  const reason = await cannotMeasure();
  if (reason !== null) return skipped(reason);
  const log = logPath(processWorld().host);
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
    about:
      "a click that starts the handler app (the live one is quit first), to the daemon's event",
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
