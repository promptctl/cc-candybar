// [LAW:verifiable-goals] brandon-doctor-v62x.a1z — "the URL handler works":
// the check's verdict over every state a `cc-candybar://` link can end in, the
// CLI's probe over a faked edge (what it opens, how long it waits, what it
// diagnoses and when), and the daemon's side of the round trip (the
// `doctor-probe` verb, who delivered a click). The URL handler is a forwarder
// (candybar-daemon-health-ajx0.co4): a link it delivers proves it, and a link
// `cc-candybar url-handle` delivered came through the retired applet.

import type { Monotonic } from "../src/time";
import { instantOf } from "../src/utils/instant";
import { RenderSightings } from "../src/daemon/render-sightings";
import {
  BUNDLED_GLYPHS,
  BUNDLED_GLYPHS_LOGGED,
  BUNDLED_GLYPHS_NAMED,
} from "./helpers/bundled-glyphs";
import { checkByName, type UrlHandlerFacts } from "../src/doctor/checks";
import {
  ProbeArrivals,
  parseArrival,
  probeUrlHandler,
  type DaemonView,
  type HandlerProbeEdge,
} from "../src/doctor/handler-probe";
import { clickArrived } from "../src/doctor/edge";
import { type ClickArrival, type Delivery } from "../src/doctor/sightings";
import { VERB_DOCTOR_PROBE, VERB_DOCTOR_RUN } from "../src/click/wire";
import { BadVerbArgs, VERBS, type VerbContext } from "../src/daemon/verbs";
import { SESSION_CLIENT_HINTS_KEY } from "../src/daemon/foundations/session-keys";
import { SessionState } from "../src/daemon/session-state";
import { doctorReportKeys } from "../src/doctor/report";
import { forwarderExecutable } from "../src/install/index";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { recordRender, testVerbContext } from "./helpers/click";
import {
  emptyStores,
  HEALTHY_FACTS,
  healthyDaemonEdge,
  healthyDataEdge,
  noManagedSettings,
  HEALTHY_SERVING,
  HEALTHY_INSTALL_EDGE,
  healthyClient,
  renderSaid,
} from "./helpers/doctor-facts";

const probe = checkByName("urlHandler")!.probe;
const verdict = (urlHandler: UrlHandlerFacts) =>
  probe({ ...HEALTHY_FACTS, urlHandler });

const APP = "/Users/u/Applications/CCCandybarURLHandler.app";
const FORWARDED = { kind: "forwarder", urlV: 1 } as const;
const CLI = { kind: "cli" } as const;
const REINSTALL = "re-run `cc-candybar install`";

describe("urlHandler probe", () => {
  test("a platform with no URL handler is ok", async () => {
    expect(verdict({ kind: "unsupported" })).toEqual({ ok: true });
  });

  test("a link the forwarder delivered is ok: it knows nothing that goes stale", async () => {
    expect(verdict({ kind: "arrived", delivery: FORWARDED })).toEqual({
      ok: true,
    });
  });

  test("a link a click request delivered is not the forwarder's", async () => {
    expect(verdict({ kind: "arrived", delivery: CLI })).toEqual({
      ok: false,
      reason: `the link was delivered by a click request (\`cc-candybar url-handle\`), not the forwarder app — ${REINSTALL}`,
    });
  });

  test("a probe that could not be attempted says why", async () => {
    expect(verdict({ kind: "unprobed", reason: "no daemon" })).toEqual({
      ok: false,
      reason: "no daemon",
    });
  });

  test("a lost link with nothing registered leads with the registration", async () => {
    expect(
      verdict({
        kind: "lost",
        unopened: "No application knows how to open URL",
        opener: { kind: "ok", value: null },
      }),
    ).toEqual({
      ok: false,
      reason: `no app is registered for cc-candybar:// — ${REINSTALL}`,
      more: [
        "a cc-candybar:// link could not be opened — No application knows how to open URL",
      ],
    });
  });

  test("a lost link whose opener is not the forwarder names the app", async () => {
    expect(
      verdict({
        kind: "lost",
        unopened: null,
        opener: { kind: "ok", value: { app: APP, forwarder: false } },
      }),
    ).toEqual({
      ok: false,
      reason: `${APP} opens cc-candybar://, but it is not the forwarder app \`cc-candybar install\` builds — ${REINSTALL}`,
      more: [
        "a cc-candybar:// link was opened and did not arrive at the daemon",
      ],
    });
  });

  test("a lost link whose opener is the forwarder reports the loss alone", async () => {
    expect(
      verdict({
        kind: "lost",
        unopened: null,
        opener: { kind: "ok", value: { app: APP, forwarder: true } },
      }),
    ).toEqual({
      ok: false,
      reason:
        "a cc-candybar:// link was opened and did not arrive at the daemon",
      more: [],
    });
  });

  test("a lookup that failed is named", async () => {
    expect(
      verdict({
        kind: "lost",
        unopened: null,
        opener: { kind: "failed", reason: "osascript: timeout" },
      }),
    ).toMatchObject({
      reason:
        "Launch Services could not be asked which app opens cc-candybar:// — osascript: timeout",
    });
  });
});

// ─── The CLI's probe ─────────────────────────────────────────────────────────

const NONCE = "123e4567-e89b-42d3-a456-426614174000";

// An edge that records what the probe did. `arrivesOnPoll` is the daemon read
// (counting the one before the link is opened as read 0) from which the nonce
// is among the arrivals; null is a link that never arrives.
function fakeEdge(
  over: Partial<HandlerProbeEdge> & { arrivesOnRead?: number | null } = {},
) {
  const { arrivesOnRead = null, ...members } = over;
  const calls: string[] = [];
  let reads = 0;
  let clock = 0;
  const edge: HandlerProbeEdge = {
    platform: "darwin",
    sockets: { own: "/tmp/s", handler: "/tmp/s" },
    monotonic: () => clock as Monotonic,
    nonce: () => NONCE,
    daemon: async () => {
      const read = reads++;
      calls.push("daemon");
      const view: DaemonView = {
        arrivals:
          arrivesOnRead !== null && read >= arrivesOnRead
            ? [
                { nonce: "another", delivery: CLI },
                { nonce: NONCE, delivery: FORWARDED },
              ]
            : [{ nonce: "another", delivery: CLI }],
      };
      return { kind: "ok", value: view };
    },
    open: (url) => {
      calls.push(`open ${url}`);
      return null;
    },
    pause: async () => {
      calls.push("pause");
      clock += 100;
    },
    opener: () => {
      calls.push("opener");
      return { kind: "ok", value: APP };
    },
    exists: (file) => {
      calls.push(`exists ${file}`);
      return file === forwarderExecutable(APP);
    },
    ...members,
  };
  return { edge, calls };
}

describe("probeUrlHandler", () => {
  test("off macOS nothing is opened or asked", async () => {
    const { edge, calls } = fakeEdge({ platform: "linux" });
    expect(await probeUrlHandler(edge)).toEqual({ kind: "unsupported" });
    expect(calls).toEqual([]);
  });

  test("a daemon that cannot be asked: no link is opened", async () => {
    const { edge, calls } = fakeEdge({
      daemon: async () => ({ kind: "failed", reason: "connect ENOENT" }),
    });
    expect(await probeUrlHandler(edge)).toEqual({
      kind: "unprobed",
      reason:
        "the daemon could not be asked whether a link arrives: connect ENOENT",
    });
    expect(calls).toEqual([]);
  });

  test("the link it opens arrives: who delivered it, and no diagnosis", async () => {
    const { edge, calls } = fakeEdge({ arrivesOnRead: 3 });
    expect(await probeUrlHandler(edge)).toEqual({
      kind: "arrived",
      delivery: FORWARDED,
    });
    expect(calls).toEqual([
      "daemon",
      `open cc-candybar://${VERB_DOCTOR_PROBE}/${NONCE}`,
      "pause",
      "daemon",
      "pause",
      "daemon",
      "pause",
      "daemon",
    ]);
  });

  test("a link that never arrives is waited for, then the opener is diagnosed", async () => {
    const { edge, calls } = fakeEdge();
    expect(await probeUrlHandler(edge)).toEqual({
      kind: "lost",
      unopened: null,
      opener: { kind: "ok", value: { app: APP, forwarder: true } },
    });
    expect(calls.filter((c) => c === "pause")).toHaveLength(50);
    expect(calls.slice(-2)).toEqual([
      "opener",
      `exists ${APP}/Contents/MacOS/CCCandybarURLHandler`,
    ]);
  });

  test("an opener whose forwarder executable is gone, or that is another app, is not the forwarder", async () => {
    const applet = fakeEdge({ exists: () => false });
    expect(await probeUrlHandler(applet.edge)).toMatchObject({
      opener: { value: { app: APP, forwarder: false } },
    });
    const other = fakeEdge({
      opener: () => ({ kind: "ok", value: "/Applications/Other.app" }),
    });
    expect(await probeUrlHandler(other.edge)).toMatchObject({
      opener: { value: { app: "/Applications/Other.app", forwarder: false } },
    });
  });

  test("the wait is five seconds on the clock, however slowly the daemon answers", async () => {
    let clock = 0;
    const { edge, calls } = fakeEdge({
      monotonic: () => clock as Monotonic,
      // Each read costs half a second on top of the pause.
      pause: async () => {
        calls.push("pause");
        clock += 600;
      },
    });
    expect(await probeUrlHandler(edge)).toMatchObject({ kind: "lost" });
    expect(calls.filter((c) => c === "pause")).toHaveLength(9);
  });

  test("a shell pointed at its own daemon: no link is opened, and both sockets are named", async () => {
    const { edge, calls } = fakeEdge({
      sockets: { own: "/tmp/dev/s", handler: "/tmp/cc-candybar-501/socket" },
    });
    expect(await probeUrlHandler(edge)).toEqual({
      kind: "unprobed",
      reason:
        "this shell's daemon is at /tmp/dev/s (CC_CANDYBAR_SOCKET); the URL handler delivers links to /tmp/cc-candybar-501/socket",
    });
    expect(calls).toEqual([]);
  });

  test("a link Launch Services refuses is not waited for", async () => {
    const { edge, calls } = fakeEdge({
      open: () => "No application knows how to open URL",
      opener: () => ({ kind: "ok", value: null }),
    });
    expect(await probeUrlHandler(edge)).toEqual({
      kind: "lost",
      unopened: "No application knows how to open URL",
      opener: { kind: "ok", value: null },
    });
    expect(calls).toEqual(["daemon"]);
  });

  test("a daemon that stops answering mid-wait is asked again", async () => {
    let reads = 0;
    const { edge } = fakeEdge({
      daemon: async () =>
        reads++ === 1
          ? { kind: "failed", reason: "timeout" }
          : {
              kind: "ok",
              value: {
                arrivals: reads > 2 ? [{ nonce: NONCE, delivery: CLI }] : [],
              },
            },
    });
    expect(await probeUrlHandler(edge)).toEqual({
      kind: "arrived",
      delivery: CLI,
    });
  });

  // [LAW:parse-dont-validate] An arrival off the wire: a daemon from before
  // the forwarder lists its probes with `handler`, not `delivery`, and is
  // told apart here, never dereferenced as one of ours.
  test("an arrival is parsed off the daemon's stats, and an older daemon's shape is not one", () => {
    expect(parseArrival({ nonce: NONCE, delivery: CLI })).toEqual({
      nonce: NONCE,
      delivery: CLI,
    });
    expect(parseArrival({ nonce: NONCE, delivery: FORWARDED })).toEqual({
      nonce: NONCE,
      delivery: FORWARDED,
    });
    expect(parseArrival({ nonce: NONCE, handler: "1.179.0" })).toBeNull();
    expect(
      parseArrival({ nonce: NONCE, delivery: { kind: "forwarder" } }),
    ).toBeNull();
    expect(
      parseArrival({ nonce: NONCE, delivery: { kind: "applet" } }),
    ).toBeNull();
    expect(parseArrival({ delivery: CLI })).toBeNull();
    expect(parseArrival(null)).toBeNull();
  });
});

// ─── The daemon's side ───────────────────────────────────────────────────────

describe("the daemon's side of the round trip", () => {
  const link = (delivery: Delivery): ClickArrival => ({
    via: "link",
    delivery,
  });

  function daemon(arrival: ClickArrival) {
    const sessionState = new SessionState();
    const probes = new ProbeArrivals();
    // The client the session's last render carried, as the daemon saw it.
    const clients = new RenderSightings();
    // From the session's own location — the origin test/helpers/click.ts
    // records, under the Claude Code directory its recorded hints name — so
    // its bar reads the click's own settings chain, never the host's.
    clients.see(
      "s1",
      renderSaid(healthyClient(), {
        projectDir: "/tmp/proj",
        claudeConfigDir: process.env.CLAUDE_CONFIG_DIR!,
      }),
      instantOf(new Date()),
      0,
    );
    const logs: string[] = [];
    const ctx: VerbContext = {
      ...testVerbContext(sessionState, undefined, DEFAULT_DSL_CONFIG),
      arrival,
      probes,
      clients,
      log: (_level, message) => logs.push(message),
      doctorStores: emptyStores(),
      doctor: {
        install: HEALTHY_INSTALL_EDGE,
        ...healthyDaemonEdge(),
        ...healthyDataEdge(),
        ...noManagedSettings(),
        probeTmux: async () => ({
          kind: "ok",
          value: {
            features: [],
            termtype: "",
            termname: "",
            pid: 4242,
            utf8: true,
          },
        }),
        remoteLogin: async () => {
          throw new Error("remoteLogin must not run in this case");
        },
        fontInUse: async () => {
          throw new Error("fontInUse must not run in this case");
        },
        loadConfig: () => ({
          layers: [],
          error: null,
          warning: null,
          unused: [],
          config: DEFAULT_DSL_CONFIG,
        }),
      },
    };
    const click = async (verb: string, value: string): Promise<void> => {
      await VERBS.get(verb)!(value, ctx);
    };
    return { sessionState, probes, logs, click };
  }

  test("a probe link records its nonce and who delivered it", async () => {
    const d = daemon(link(FORWARDED));
    await d.click(VERB_DOCTOR_PROBE, NONCE);
    expect(d.probes.list()).toEqual([{ nonce: NONCE, delivery: FORWARDED }]);
    expect(d.logs).toEqual([
      `doctor-probe: arrived nonce=${NONCE} delivery=forwarder`,
    ]);
  });

  test("a probe the CLI delivered is recorded as such", async () => {
    const d = daemon(link(CLI));
    await d.click(VERB_DOCTOR_PROBE, NONCE);
    expect(d.probes.list()).toEqual([{ nonce: NONCE, delivery: CLI }]);
    expect(d.logs).toEqual([
      `doctor-probe: arrived nonce=${NONCE} delivery=cli`,
    ]);
  });

  test("a value that is not a probe nonce is refused and records nothing", async () => {
    const d = daemon(link(FORWARDED));
    await expect(d.click(VERB_DOCTOR_PROBE, "../../etc")).rejects.toThrow(
      BadVerbArgs,
    );
    expect(d.probes.list()).toEqual([]);
  });

  test("only the newest arrivals are kept", async () => {
    const probes = new ProbeArrivals();
    for (let i = 0; i < 20; i++) {
      probes.arrive({ nonce: `n${i}`, delivery: CLI });
    }
    expect(probes.list().map((a) => a.nonce)).toEqual(
      Array.from({ length: 16 }, (_, i) => `n${i + 4}`),
    );
  });

  // In the bar, the doctor's own click is the link that came back.
  async function doctorRow(arrival: ClickArrival) {
    const d = daemon(arrival);
    recordRender(d.sessionState, "s1");
    // The session's own Claude Code directory (test/setup.ts's empty one):
    // with none, the doctor reads ~/.claude, the host's real settings.
    d.sessionState.set(
      "s1",
      SESSION_CLIENT_HINTS_KEY,
      JSON.stringify({
        tmux: null,
        claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
        terminalEnv: { TERM_PROGRAM: "ghostty" },
        termCols: 148,
      }),
    );
    await d.click(VERB_DOCTOR_RUN, "s1");
    const keys = doctorReportKeys("urlHandler");
    return {
      verdict: d.sessionState.get("s1", keys.verdict),
      reason: d.sessionState.get("s1", keys.reason),
      logs: d.logs,
    };
  }

  test("a doctor click the forwarder delivered: the row is ok", async () => {
    const row = await doctorRow(link(FORWARDED));
    expect(row.verdict).toBe("ok");
    expect(row.logs).toEqual([
      `doctor: config=ok install=ok daemon=ok urlHandler=ok links=ok tmuxTruecolor=ok utf8=ok termWidth=ok effectRefresh=ok nerdFont=ok segmentData=ok sessionData=ok configTarget=search glyphs=${BUNDLED_GLYPHS_LOGGED} terminal=ghostty@- font=- mark=- tmuxLinks=- clicked=yes cols=148 widthOf=session clientUtf8=- clients=native/same/- daemons=1 others=- memory=phys_footprint:120/512 postMortems=0/0 data=pr:-,rateLimits:1/0/0 transcripts=1/0/0 unparsed=0 frames=0/0/1/0/0 chains=absent truecolorEnv=unset (session=s1)`,
    ]);
  });

  test("a doctor click a click request delivered: the row says it was not the forwarder", async () => {
    const row = await doctorRow(link(CLI));
    expect(row.verdict).toBe("failed");
    expect(row.reason).toBe(
      `the link was delivered by a click request (\`cc-candybar url-handle\`), not the forwarder app — ${REINSTALL}`,
    );
    expect(row.logs).toEqual([
      `doctor: config=ok install=ok daemon=ok urlHandler=failed(1) links=ok tmuxTruecolor=ok utf8=ok termWidth=ok effectRefresh=ok nerdFont=ok segmentData=ok sessionData=ok configTarget=search glyphs=${BUNDLED_GLYPHS_LOGGED} terminal=ghostty@- font=- mark=- tmuxLinks=- clicked=yes cols=148 widthOf=session clientUtf8=- clients=native/same/- daemons=1 others=- memory=phys_footprint:120/512 postMortems=0/0 data=pr:-,rateLimits:1/0/0 transcripts=1/0/0 unparsed=0 frames=0/0/1/0/0 chains=absent truecolorEnv=unset (session=s1)`,
    ]);
  });

  // Review of PR #405: tmux runs a status-line click itself, so it proves
  // neither the handler nor that the terminal draws links.
  test("a doctor click from the tmux status line proves neither the handler nor links, and files no terminal", async () => {
    const row = await doctorRow({ via: "tmux-status" });
    expect(row.verdict).toBe("failed");
    expect(row.reason).toContain("asked from the tmux status line");
    expect(row.logs).toHaveLength(1);
    expect(row.logs[0]).toContain(" clicked=no ");
  });

  test("a probe cannot arrive from the tmux status line", async () => {
    const d = daemon({ via: "tmux-status" });
    await expect(d.click(VERB_DOCTOR_PROBE, NONCE)).rejects.toThrow(
      BadVerbArgs,
    );
    expect(d.probes.list()).toEqual([]);
  });

  test("a click's arrival is the fact its doctor row reads", async () => {
    expect(clickArrived(link(FORWARDED))).toEqual({
      kind: "arrived",
      delivery: FORWARDED,
    });
  });
});
