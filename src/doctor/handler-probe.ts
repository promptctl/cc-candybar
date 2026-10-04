// The URL-handler probe: `cc-candybar doctor` opens a `cc-candybar://` link
// and asks the daemon whether it arrived.
//
// The bar never runs this — a doctor click there already came back through
// the handler (edge.ts `clickArrived`). The CLI has no click, so it sends a
// link of its own: Launch Services hands it to the handler app, the app runs
// `url-handle`, and that delivers the `doctor-probe` verb to the daemon, which
// lists what arrived in its stats. A link that does not come back is then
// diagnosed: which app Launch Services opens the scheme with, and whether the
// files that app's script runs still exist.
//
// [LAW:effects-at-boundaries] Every effect is a member of `HandlerProbeEdge`;
// `probeUrlHandler` is the sequence over them, and a test hands in its own.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { URL_SCHEME, VERB_DOCTOR_PROBE } from "../click/wire.js";
import { describeFailure } from "../daemon/client-transport.js";
import { fetchStats } from "../daemon/client-stats.js";
import { handlerCommand, handlerScriptPath } from "../install/index.js";
import { launchSync, type LaunchCategory } from "../proc/launch.js";
import type { Asked, HandlerApp, UrlHandlerFacts } from "./checks.js";

const ok = <T>(value: T): Asked<T> => ({ kind: "ok", value });
const failed = (reason: string): Asked<never> => ({ kind: "failed", reason });

export interface ProbeArrival {
  readonly nonce: string;
  // The version the handler that delivered the link reports, or null from
  // one too old to report it.
  readonly handler: string | null;
}

// The daemon's record of the probe links that reached it — the newest few,
// since a probe is read back within seconds of being sent.
const ARRIVALS_KEPT = 16;

export class ProbeArrivals {
  private arrivals: readonly ProbeArrival[] = [];

  arrive(arrival: ProbeArrival): void {
    this.arrivals = [...this.arrivals, arrival].slice(-ARRIVALS_KEPT);
  }

  list(): readonly ProbeArrival[] {
    return this.arrivals;
  }
}

// [LAW:parse-dont-validate] The nonce is the CLI's `randomUUID()`; anything
// else on the wire is not a probe this code sent.
const NONCE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function parseProbeNonce(value: string): string | null {
  return NONCE.test(value) ? value : null;
}

// What the CLI needs of the running daemon: the version the bar runs, and the
// probes that reached it.
export interface DaemonView {
  readonly version: string;
  readonly arrivals: readonly ProbeArrival[];
}

export interface HandlerProbeEdge {
  readonly platform: NodeJS.Platform;
  readonly nonce: () => string;
  readonly daemon: () => Promise<Asked<DaemonView>>;
  // Hand a URL to Launch Services. The reason it refused, or null.
  readonly open: (url: string) => string | null;
  // One poll interval.
  readonly pause: () => Promise<void>;
  // The app Launch Services opens the scheme with; null when none claims it.
  readonly opener: () => Asked<string | null>;
  // The source of the script an app bundle runs.
  readonly script: (app: string) => Asked<string>;
  readonly exists: (file: string) => boolean;
}

// Five seconds for Launch Services to start the handler app and node to
// deliver the link; one not back by then is reported lost.
const POLLS = 50;
const POLL_MS = 100;

function handlerApp(edge: HandlerProbeEdge): Asked<HandlerApp | null> {
  const opener = edge.opener();
  if (opener.kind === "failed") return opener;
  if (opener.value === null) return ok(null);
  const app = opener.value;
  const source = edge.script(app);
  if (source.kind === "failed") {
    return ok({
      app,
      missing: failed(`its script could not be read (${source.reason})`),
    });
  }
  const command = handlerCommand(source.value);
  return ok({
    app,
    missing:
      command === null
        ? failed("its script is not one `cc-candybar install` wrote")
        : ok(
            [command.node, command.script].filter((file) => !edge.exists(file)),
          ),
  });
}

async function awaitArrival(
  edge: HandlerProbeEdge,
  nonce: string,
): Promise<UrlHandlerFacts | null> {
  for (let poll = 0; poll < POLLS; poll++) {
    await edge.pause();
    const view = await edge.daemon();
    // A daemon that cannot be asked this instant may answer the next poll.
    const arrival =
      view.kind === "ok"
        ? view.value.arrivals.find((a) => a.nonce === nonce)
        : undefined;
    if (view.kind === "ok" && arrival !== undefined) {
      return {
        kind: "arrived",
        handler: arrival.handler,
        bar: view.value.version,
      };
    }
  }
  return null;
}

export async function probeUrlHandler(
  edge: HandlerProbeEdge,
): Promise<UrlHandlerFacts> {
  if (edge.platform !== "darwin") return { kind: "unsupported" };
  // The link is delivered to the daemon, so one that cannot be asked can
  // neither receive it nor say that it did.
  const daemon = await edge.daemon();
  if (daemon.kind === "failed") {
    return {
      kind: "unprobed",
      reason: `the daemon could not be asked whether a link arrives: ${daemon.reason}`,
    };
  }
  const nonce = edge.nonce();
  const unopened = edge.open(`${URL_SCHEME}://${VERB_DOCTOR_PROBE}/${nonce}`);
  const arrived = unopened === null ? await awaitArrival(edge, nonce) : null;
  return arrived ?? { kind: "lost", unopened, opener: handlerApp(edge) };
}

// ─── The production edge ─────────────────────────────────────────────────────

function run(
  category: LaunchCategory,
  bin: string,
  args: readonly string[],
): Asked<string> {
  const result = launchSync({ bin, args: [...args], category });
  return result.ok
    ? ok(result.stdout)
    : failed(result.stderr.trim() || result.error || result.reason);
}

// NSWorkspace's own answer to "which app opens this URL" — the lookup `open`
// performs. Prints the app's path, or nothing when no app claims the scheme.
const OPENER_SCRIPT =
  'ObjC.import("AppKit");' +
  `var u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("${URL_SCHEME}://probe"));` +
  'u.isNil() ? "" : u.path.js';

async function daemonView(): Promise<Asked<DaemonView>> {
  const outcome = await fetchStats();
  if (outcome.kind !== "ok") return failed(describeFailure(outcome));
  const { version, handlerProbes } = outcome.value;
  // [LAW:no-defensive-null-guards] exception: trust boundary. The snapshot is
  // socket JSON from whichever daemon is running; one from before this check
  // carries no arrivals and would never record the probe.
  if (!Array.isArray(handlerProbes)) {
    return failed(`the running daemon (${version}) predates this check`);
  }
  return ok({ version, arrivals: handlerProbes });
}

export function productionHandlerProbeEdge(): HandlerProbeEdge {
  return {
    platform: process.platform,
    nonce: randomUUID,
    daemon: daemonView,
    open: (url) => {
      // -g: the handler app must not take focus from the terminal.
      const opened = run("doctor.open", "/usr/bin/open", ["-g", url]);
      return opened.kind === "ok" ? null : opened.reason;
    },
    pause: () => new Promise((resolve) => setTimeout(resolve, POLL_MS)),
    opener: () => {
      const asked = run("doctor.launch-services", "/usr/bin/osascript", [
        "-l",
        "JavaScript",
        "-e",
        OPENER_SCRIPT,
      ]);
      if (asked.kind === "failed") return asked;
      const app = asked.value.trim();
      return ok(app === "" ? null : app);
    },
    script: (app) =>
      run("doctor.osadecompile", "/usr/bin/osadecompile", [
        handlerScriptPath(app),
      ]),
    exists: fs.existsSync,
  };
}
