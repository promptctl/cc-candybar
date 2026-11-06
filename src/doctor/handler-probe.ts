// The URL-handler probe: `cc-candybar doctor` opens a `cc-candybar://` link
// and asks the daemon whether it arrived.
//
// The bar never runs this — a doctor click there already came back through
// the handler (edge.ts `clickArrived`). The CLI has no click, so it sends a
// link of its own: Launch Services hands it to the handler app, which forwards
// it to the daemon, where the `probe` verb lists it among the arrivals
// in its stats. A link that does not come back is then diagnosed: which app
// Launch Services opens that link with, whether it is the forwarder, and
// whether the daemon is another build, which may not read the link at all.
//
// [LAW:effects-at-boundaries] Every effect is a member of `HandlerProbeEdge`;
// `probeUrlHandler` is the sequence over them, and a test hands in its own.

import { randomUUID } from "node:crypto";
import { sleep, type Monotonic } from "../time.js";
import fs from "node:fs";
import { probeLink } from "../click/wire.js";
import { describeFailure } from "../daemon/client-transport.js";
import { fetchStats, otherBuild, shapeSkew } from "../daemon/client-stats.js";
import type { ClientWorld } from "../daemon/client-transport.js";
import type { RendererAddress } from "../daemon/home.js";
import { handlerSocketPath, socketPath } from "../daemon/paths.js";
import { forwarderExecutable } from "../install/index.js";
import {
  failureText,
  type LaunchCategory,
  type OneShotLauncher,
} from "../proc/launch.js";
import type { Asked, HandlerApp, UrlHandlerFacts } from "./checks.js";
import type { Delivery } from "./sightings.js";

const ok = <T>(value: T): Asked<T> => ({ kind: "ok", value });
const failed = (reason: string): Asked<never> => ({ kind: "failed", reason });

export interface ProbeArrival {
  readonly nonce: string;
  readonly delivery: Delivery;
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

// What the CLI needs of the running daemon: the probes that reached it, and
// whether it is this CLI's build.
export interface DaemonView {
  readonly arrivals: readonly ProbeArrival[];
  readonly otherBuild: string | null;
}

export interface HandlerProbeEdge {
  readonly platform: NodeJS.Platform;
  // The renderer this shell reaches, whose name the probe's link carries.
  readonly name: RendererAddress;
  // The socket this process reaches its daemon on, and the one the handler
  // app delivers a link naming it to: they differ under an override.
  readonly sockets: { readonly own: string; readonly handler: string };
  readonly nonce: () => string;
  readonly daemon: () => Promise<Asked<DaemonView>>;
  // Hand a URL to Launch Services. The reason it refused, or null.
  readonly open: (url: string) => string | null;
  // A monotonic reading, in milliseconds, for the wait's bound.
  readonly monotonic: () => Monotonic;
  // One poll interval.
  readonly pause: () => Promise<void>;
  // The app Launch Services opens this URL with; null when none claims it.
  readonly opener: (url: string) => Asked<string | null>;
  readonly exists: (file: string) => boolean;
}

// Five seconds for Launch Services to start the handler app and the app to
// forward the link; one not back by then is reported lost.
const WAIT_MS = 5000;
const POLL_MS = 100;

function handlerApp(
  edge: HandlerProbeEdge,
  url: string,
): Asked<HandlerApp | null> {
  const opener = edge.opener(url);
  if (opener.kind === "failed") return opener;
  if (opener.value === null) return ok(null);
  const app = opener.value;
  return ok({ app, forwarder: edge.exists(forwarderExecutable(app)) });
}

async function awaitArrival(
  edge: HandlerProbeEdge,
  nonce: string,
): Promise<UrlHandlerFacts | null> {
  // [LAW:no-ambient-temporal-coupling] The bound is the clock's, so a daemon
  // slow to answer each read cannot stretch the wait.
  const deadline = edge.monotonic() + WAIT_MS;
  while (edge.monotonic() < deadline) {
    await edge.pause();
    const view = await edge.daemon();
    // A daemon that cannot be asked this instant may answer the next poll.
    const arrival =
      view.kind === "ok"
        ? view.value.arrivals.find((a) => a.nonce === nonce)
        : undefined;
    if (view.kind === "ok" && arrival !== undefined) {
      return { kind: "arrived", delivery: arrival.delivery };
    }
  }
  return null;
}

export async function probeUrlHandler(
  edge: HandlerProbeEdge,
): Promise<UrlHandlerFacts> {
  if (edge.platform !== "darwin") return { kind: "unsupported" };
  // The probe's link names this shell's renderer, and the handler delivers it
  // to the socket that name selects in the uid's directory: a daemon this
  // shell reaches elsewhere (an override) would never see it arrive.
  if (edge.sockets.own !== edge.sockets.handler) {
    return {
      kind: "unprobed",
      reason: `this shell's daemon is at ${edge.sockets.own}; the URL handler delivers a link naming ${edge.name} to ${edge.sockets.handler}`,
    };
  }
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
  const link = probeLink(edge.name, nonce);
  const unopened = edge.open(link);
  const arrived = unopened === null ? await awaitArrival(edge, nonce) : null;
  // A lost link is diagnosed by the app Launch Services opens that link with,
  // and by the build of the daemon it was sent to.
  return (
    arrived ?? {
      kind: "lost",
      unopened,
      opener: handlerApp(edge, link),
      otherBuild: daemon.value.otherBuild,
    }
  );
}

// ─── The production edge ─────────────────────────────────────────────────────

// Each of the probe's three commands answers in well under a second; one that
// has not by now (no window server to ask, as over SSH) is a failure to report.
const SPAWN_MS = 5000;

function run(
  launcher: OneShotLauncher,
  category: LaunchCategory,
  bin: string,
  args: readonly string[],
): Asked<string> {
  const result = launcher.launchSync({
    bin,
    args: [...args],
    category,
    timeoutMs: SPAWN_MS,
  });
  return result.ok ? ok(result.stdout) : failed(failureText(result));
}

// NSWorkspace's own answer to "which app opens this URL" — the lookup `open`
// performs. Prints the app's path, or nothing when no app claims the scheme.
const openerScript = (url: string): string =>
  'ObjC.import("AppKit");' +
  `var u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString(${JSON.stringify(url)}));` +
  'u.isNil() ? "" : u.path.js';

async function daemonView(world: ClientWorld): Promise<Asked<DaemonView>> {
  const outcome = await fetchStats(world);
  // The description is lines (a failure, then its hint); a verdict's reason is
  // one row.
  if (outcome.kind !== "ok") {
    return failed(describeFailure(outcome).split("\n").join(" — "));
  }
  // A daemon of another build may carry no arrivals and would never record
  // the probe: told by the one shape comparison daemon-stats makes.
  const skew = shapeSkew(outcome.value, ["handlerProbes"]);
  if (skew !== null) return failed(skew);
  // [LAW:parse-dont-validate] An arrival is read off the wire here, once: a
  // daemon from before the forwarder lists its probes with no delivery, and
  // that is told as the skew it is, never carried on as one.
  const arrivals: ProbeArrival[] = [];
  for (const raw of outcome.value.handlerProbes) {
    const arrival = parseArrival(raw);
    if (arrival === null) {
      return failed(
        "the daemon lists its probe arrivals without who delivered them, so it is from a build before the forwarder app — restart it to run the installed one",
      );
    }
    arrivals.push(arrival);
  }
  return ok({ arrivals, otherBuild: otherBuild(outcome.value) });
}

export function parseArrival(raw: unknown): ProbeArrival | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { nonce, delivery } = raw as { nonce?: unknown; delivery?: unknown };
  if (typeof nonce !== "string") return null;
  if (typeof delivery !== "object" || delivery === null) return null;
  const { kind, urlV } = delivery as { kind?: unknown; urlV?: unknown };
  if (kind === "cli") return { nonce, delivery: { kind: "cli" } };
  if (kind === "forwarder" && typeof urlV === "number") {
    return { nonce, delivery: { kind: "forwarder", urlV } };
  }
  return null;
}

export function productionHandlerProbeEdge(
  launcher: OneShotLauncher,
  world: ClientWorld,
): HandlerProbeEdge {
  const { home, clock } = world;
  return {
    platform: process.platform,
    name: home.name,
    sockets: { own: socketPath(home), handler: handlerSocketPath(home.name) },
    monotonic: () => clock.monotonic(),
    nonce: randomUUID,
    daemon: () => daemonView(world),
    open: (url) => {
      // -g: the handler app must not take focus from the terminal.
      const opened = run(launcher, "doctor.open", "/usr/bin/open", ["-g", url]);
      return opened.kind === "ok" ? null : opened.reason;
    },
    pause: () => sleep(clock, POLL_MS),
    opener: (url) => {
      const asked = run(
        launcher,
        "doctor.launch-services",
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", openerScript(url)],
      );
      if (asked.kind === "failed") return asked;
      const app = asked.value.trim();
      return ok(app === "" ? null : app);
    },
    exists: fs.existsSync,
  };
}
