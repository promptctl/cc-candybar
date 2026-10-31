// [LAW:verifiable-goals] brandon-doctor-v62x.a1z — "the URL handler works":
// the check's verdict over every state a `cc-candybar://` link can end in, the
// CLI's probe over a faked edge (what it opens, how long it waits, what it
// diagnoses and when), the daemon's side of the round trip (the `doctor-probe`
// verb, the handler version a click carries), and the reading of the handler
// app's script against the installer that writes it.

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
  probeUrlHandler,
  type DaemonView,
  type HandlerProbeEdge,
} from "../src/doctor/handler-probe";
import { clickArrived } from "../src/doctor/edge";
import type { ClickArrival } from "../src/doctor/sightings";
import { VERB_DOCTOR_PROBE, VERB_DOCTOR_RUN } from "../src/click/wire";
import { BadVerbArgs, VERBS, type VerbContext } from "../src/daemon/verbs";
import { SESSION_CLIENT_HINTS_KEY } from "../src/daemon/verbs";
import { SessionState } from "../src/daemon/session-state";
import { sanitizeClientVersion } from "../src/daemon/protocol";
import { doctorReportKeys } from "../src/doctor/report";
import {
  __test__ as install,
  handlerCommand,
  handlerScriptPath,
} from "../src/install/index";
import { PACKAGE_VERSION } from "../src/version";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { recordRender, testVerbContext } from "./helpers/click";
import { emptyStores, HEALTHY_FACTS, healthyDaemonEdge, healthyDataEdge, noManagedSettings, HEALTHY_SERVING, HEALTHY_INSTALL_EDGE, healthyClient, renderSaid } from "./helpers/doctor-facts";

const probe = checkByName("urlHandler")!.probe;
const verdict = (urlHandler: UrlHandlerFacts) =>
  probe({ ...HEALTHY_FACTS, urlHandler });

const APP = "/Users/u/Applications/CCCandybarURLHandler.app";

describe("urlHandler probe", () => {
  test("a platform with no URL handler is ok", () => {
    expect(verdict({ kind: "unsupported" })).toEqual({ ok: true });
  });

  test("a link delivered by the version the bar runs is ok", () => {
    expect(
      verdict({ kind: "arrived", handler: "1.2.3", bar: "1.2.3" }),
    ).toEqual({ ok: true });
  });

  test("a link delivered by another version names both", () => {
    expect(
      verdict({ kind: "arrived", handler: "1.2.0", bar: "1.2.3" }),
    ).toEqual({
      ok: false,
      reason:
        "the URL handler runs cc-candybar 1.2.0; the bar runs 1.2.3 — re-run `cc-candybar install`",
    });
  });

  test("a handler too old to report its version is not ok", () => {
    expect(verdict({ kind: "arrived", handler: null, bar: "1.2.3" })).toEqual({
      ok: false,
      reason:
        "the URL handler does not report its version, so it is older than the bar (1.2.3) — re-run `cc-candybar install`",
    });
  });

  test("a probe that could not be attempted says why", () => {
    expect(verdict({ kind: "unprobed", reason: "no daemon" })).toEqual({
      ok: false,
      reason: "no daemon",
    });
  });

  test("a lost link with nothing registered leads with the registration", () => {
    expect(
      verdict({
        kind: "lost",
        unopened: "No application knows how to open URL",
        opener: { kind: "ok", value: null },
      }),
    ).toEqual({
      ok: false,
      reason:
        "no app is registered for cc-candybar:// — re-run `cc-candybar install`",
      more: [
        "a cc-candybar:// link could not be opened — No application knows how to open URL",
      ],
    });
  });

  test("a lost link names each file the handler app runs that is gone", () => {
    expect(
      verdict({
        kind: "lost",
        unopened: null,
        opener: {
          kind: "ok",
          value: { app: APP, missing: { kind: "ok", value: ["/old/node"] } },
        },
      }),
    ).toEqual({
      ok: false,
      reason: `/old/node is missing, and ${APP} runs it — re-run \`cc-candybar install\``,
      more: [
        "a cc-candybar:// link was opened and did not arrive at the daemon",
      ],
    });
  });

  test("a lost link whose handler app is intact reports the loss alone", () => {
    expect(
      verdict({
        kind: "lost",
        unopened: null,
        opener: {
          kind: "ok",
          value: { app: APP, missing: { kind: "ok", value: [] } },
        },
      }),
    ).toEqual({
      ok: false,
      reason:
        "a cc-candybar:// link was opened and did not arrive at the daemon",
      more: [],
    });
  });

  test("an app whose script cannot be read, and a lookup that failed, are named", () => {
    expect(
      verdict({
        kind: "lost",
        unopened: null,
        opener: {
          kind: "ok",
          value: {
            app: "/Applications/Other.app",
            missing: {
              kind: "failed",
              reason: "its script is not one `cc-candybar install` wrote",
            },
          },
        },
      }),
    ).toMatchObject({
      reason:
        "/Applications/Other.app opens cc-candybar://, but its script is not one `cc-candybar install` wrote — re-run `cc-candybar install`",
    });
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
const SCRIPT = install.appleScriptSource("/bin/node", "/rt/dist/index.mjs");

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
    now: () => clock,
    nonce: () => NONCE,
    daemon: async () => {
      const read = reads++;
      calls.push("daemon");
      const view: DaemonView = {
        version: "1.2.3",
        arrivals:
          arrivesOnRead !== null && read >= arrivesOnRead
            ? [
                { nonce: "another", handler: "0.0.1" },
                { nonce: NONCE, handler: "1.2.3" },
              ]
            : [{ nonce: "another", handler: "0.0.1" }],
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
    script: (app) => {
      calls.push(`script ${app}`);
      return { kind: "ok", value: SCRIPT };
    },
    exists: (file) => file !== "/bin/node",
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

  test("the link it opens arrives: the handler's version beside the daemon's, and no diagnosis", async () => {
    const { edge, calls } = fakeEdge({ arrivesOnRead: 3 });
    expect(await probeUrlHandler(edge)).toEqual({
      kind: "arrived",
      handler: "1.2.3",
      bar: "1.2.3",
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

  test("a link that never arrives is waited for, then diagnosed", async () => {
    const { edge, calls } = fakeEdge();
    expect(await probeUrlHandler(edge)).toEqual({
      kind: "lost",
      unopened: null,
      opener: {
        kind: "ok",
        value: { app: APP, missing: { kind: "ok", value: ["/bin/node"] } },
      },
    });
    expect(calls.filter((c) => c === "pause")).toHaveLength(50);
    expect(calls.slice(-2)).toEqual(["opener", `script ${APP}`]);
  });

  test("the wait is five seconds on the clock, however slowly the daemon answers", async () => {
    let clock = 0;
    const { edge, calls } = fakeEdge({
      now: () => clock,
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

  test("an app whose script this installer did not write, or that cannot be read", async () => {
    const foreign = fakeEdge({
      script: () => ({ kind: "ok", value: 'display dialog "hi"' }),
    });
    expect(await probeUrlHandler(foreign.edge)).toMatchObject({
      opener: {
        value: {
          missing: {
            kind: "failed",
            reason: "its script is not one `cc-candybar install` wrote",
          },
        },
      },
    });
    const unreadable = fakeEdge({
      script: () => ({ kind: "failed", reason: "no such file" }),
    });
    expect(await probeUrlHandler(unreadable.edge)).toMatchObject({
      opener: {
        value: {
          missing: {
            kind: "failed",
            reason: "its script could not be read (no such file)",
          },
        },
      },
    });
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
                version: "1.2.3",
                arrivals: reads > 2 ? [{ nonce: NONCE, handler: null }] : [],
              },
            },
    });
    expect(await probeUrlHandler(edge)).toEqual({
      kind: "arrived",
      handler: null,
      bar: "1.2.3",
    });
  });
});

// ─── The handler app's script ────────────────────────────────────────────────

describe("handlerCommand", () => {
  test("reads back the two paths the installer bakes in", () => {
    const node = "/opt/homebrew/Cellar/node/26.7.0/bin/node";
    const script = "/Users/u/Library/Application Support/CCCandybar/dist/index.mjs";
    expect(handlerCommand(install.appleScriptSource(node, script))).toEqual({
      node,
      script,
    });
  });

  test("a path holding a double quote survives the script's escaping", () => {
    expect(
      handlerCommand(install.appleScriptSource('/a "b"/node', "/s.mjs")),
    ).toEqual({ node: '/a "b"/node', script: "/s.mjs" });
  });

  test("a script that is not the installer's is not read as one", () => {
    expect(handlerCommand('do shell script "open " & L')).toBeNull();
  });

  test("the compiled script sits where osacompile puts it", () => {
    expect(handlerScriptPath(APP)).toBe(
      `${APP}/Contents/Resources/Scripts/main.scpt`,
    );
  });
});

// ─── The daemon's side ───────────────────────────────────────────────────────

describe("the daemon's side of the round trip", () => {
  // A click the URL handler of version `handler` delivered.
  const link = (handler: string | null): ClickArrival => ({
    via: "link",
    handler,
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
        probeTmux: () => ({
          kind: "ok",
          value: { features: [], termtype: "", termname: "", pid: 4242, utf8: true },
        }),
        remoteLogin: () => {
          throw new Error("remoteLogin must not run in this case");
        },
        fontInUse: () => {
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
    const click = (verb: string, value: string): void =>
      VERBS.get(verb)!(value, ctx);
    return { sessionState, probes, logs, click };
  }

  test("a probe link records its nonce and the handler that delivered it", () => {
    const d = daemon(link("1.2.3"));
    d.click(VERB_DOCTOR_PROBE, NONCE);
    expect(d.probes.list()).toEqual([{ nonce: NONCE, handler: "1.2.3" }]);
    expect(d.logs).toEqual([
      `doctor-probe: arrived nonce=${NONCE} handler=1.2.3`,
    ]);
  });

  test("a probe from a handler that reports no version is recorded as such", () => {
    const d = daemon(link(null));
    d.click(VERB_DOCTOR_PROBE, NONCE);
    expect(d.probes.list()).toEqual([{ nonce: NONCE, handler: null }]);
    expect(d.logs).toEqual([
      `doctor-probe: arrived nonce=${NONCE} handler=unreported`,
    ]);
  });

  test("a value that is not a probe nonce is refused and records nothing", () => {
    const d = daemon(link("1.2.3"));
    expect(() => d.click(VERB_DOCTOR_PROBE, "../../etc")).toThrow(BadVerbArgs);
    expect(d.probes.list()).toEqual([]);
  });

  test("only the newest arrivals are kept", () => {
    const probes = new ProbeArrivals();
    for (let i = 0; i < 20; i++) {
      probes.arrive({ nonce: `n${i}`, handler: null });
    }
    expect(probes.list().map((a) => a.nonce)).toEqual(
      Array.from({ length: 16 }, (_, i) => `n${i + 4}`),
    );
  });

  // In the bar, the doctor's own click is the link that came back.
  function doctorRow(arrival: ClickArrival) {
    const d = daemon(arrival);
    recordRender(d.sessionState, "s1");
    // The session's own Claude Code directory (test/setup.ts's empty one):
    // with none, the doctor reads ~/.claude, the host's real settings.
    d.sessionState.set("s1", SESSION_CLIENT_HINTS_KEY, JSON.stringify({ tmux: null, claudeConfigDir: process.env.CLAUDE_CONFIG_DIR, terminalEnv: { TERM_PROGRAM: "ghostty" }, termCols: 148 }));
    d.click(VERB_DOCTOR_RUN, "s1");
    const keys = doctorReportKeys("urlHandler");
    return {
      verdict: d.sessionState.get("s1", keys.verdict),
      reason: d.sessionState.get("s1", keys.reason),
      logs: d.logs,
    };
  }

  test("a doctor click delivered by this version's handler: the row is ok", () => {
    const row = doctorRow(link(PACKAGE_VERSION));
    expect(row.verdict).toBe("ok");
    expect(row.logs).toEqual([
      `doctor: config=ok install=ok daemon=ok urlHandler=ok links=ok tmuxTruecolor=ok utf8=ok termWidth=ok effectRefresh=ok nerdFont=ok segmentData=ok sessionData=ok configTarget=search glyphs=${BUNDLED_GLYPHS_LOGGED} terminal=ghostty@- font=- mark=- tmuxLinks=- clicked=yes cols=148 widthOf=session clientUtf8=- clients=native/same/- daemons=1 others=- memory=phys_footprint:120/512 postMortems=0/0 data=pr:-,rateLimits:1/0/0 transcripts=1/0/0 unparsed=0 frames=0/0/1/0/0 chains=absent truecolorEnv=unset (session=s1)`,
    ]);
  });

  test("a doctor click delivered by an older handler: the row names both versions", () => {
    const row = doctorRow(link("0.0.1"));
    expect(row.verdict).toBe("failed");
    expect(row.reason).toBe(
      `the URL handler runs cc-candybar 0.0.1; the bar runs ${PACKAGE_VERSION} — re-run \`cc-candybar install\``,
    );
    expect(row.logs).toEqual([
      `doctor: config=ok install=ok daemon=ok urlHandler=failed(1) links=ok tmuxTruecolor=ok utf8=ok termWidth=ok effectRefresh=ok nerdFont=ok segmentData=ok sessionData=ok configTarget=search glyphs=${BUNDLED_GLYPHS_LOGGED} terminal=ghostty@- font=- mark=- tmuxLinks=- clicked=yes cols=148 widthOf=session clientUtf8=- clients=native/same/- daemons=1 others=- memory=phys_footprint:120/512 postMortems=0/0 data=pr:-,rateLimits:1/0/0 transcripts=1/0/0 unparsed=0 frames=0/0/1/0/0 chains=absent truecolorEnv=unset (session=s1)`,
    ]);
  });

  // Review of PR #405: tmux runs a status-line click itself, so it proves
  // neither the handler nor that the terminal draws links.
  test("a doctor click from the tmux status line proves neither the handler nor links, and files no terminal", () => {
    const row = doctorRow({ via: "tmux-status" });
    expect(row.verdict).toBe("failed");
    expect(row.reason).toContain("asked from the tmux status line");
    expect(row.logs).toHaveLength(1);
    expect(row.logs[0]).toContain(" clicked=no ");
  });

  test("a probe cannot arrive from the tmux status line", () => {
    const d = daemon({ via: "tmux-status" });
    expect(() => d.click(VERB_DOCTOR_PROBE, NONCE)).toThrow(BadVerbArgs);
    expect(d.probes.list()).toEqual([]);
  });

  test("a click's handler version is this daemon's own beside it", () => {
    expect(clickArrived({ via: "link", handler: null })).toEqual({
      kind: "arrived",
      handler: null,
      bar: PACKAGE_VERSION,
    });
  });

  test("the wire's client version is a short non-empty string or nothing", () => {
    expect(sanitizeClientVersion("1.2.3")).toBe("1.2.3");
    expect(sanitizeClientVersion(undefined)).toBeNull();
    expect(sanitizeClientVersion("")).toBeNull();
    expect(sanitizeClientVersion(7)).toBeNull();
    expect(sanitizeClientVersion("x".repeat(65))).toBeNull();
  });
});
