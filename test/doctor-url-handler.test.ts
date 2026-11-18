// [LAW:verifiable-goals] brandon-doctor-v62x.a1z — "the URL handler works":
// the check's verdict over every state a `cc-candybar://` link can end in, and
// the daemon's side (who delivered a click, and what a run with no link reads
// of the registration). The URL handler is a forwarder
// (candybar-daemon-health-ajx0.co4): a link it delivers proves it, and a link
// `cc-candybar url-handle` delivered came through the retired applet.

import { DOCTOR_NOTE } from "../src/renderer-interface/noted-doctor";
import { notedReportsOf } from "./helpers/doctor-note";
import {
  checkByName,
  notJudged,
  type HandlerApp,
  type UrlHandlerFacts,
} from "../src/doctor/checks";
import { type ClickArrival, type Delivery } from "../src/doctor/sightings";
import type { HandlerRegistration } from "../src/doctor/ports";
import { VERB_DOCTOR_RUN } from "../src/click/wire";
import { type VerbContext } from "../src/renderer/verbs";
import { parseClick } from "../src/daemon/click-reading";
import { linkSignerOver } from "../src/click/link-signer";
import { SessionState } from "../src/renderer/session-state";
import { doctorReportKeys } from "../src/doctor/report";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import {
  testVerbContext,
  verbContextWith,
  withDoctor,
  bookedContext,
  hearRender,
  heardRequest,
  clickVerb,
} from "./helpers/click";
import { DoctorHost } from "./helpers/doctor-gather";
import { systemTimekeeper } from "../src/time";
import { instantAt } from "../src/utils/instant";
import {
  emptyStores,
  HEALTHY_FACTS,
  healthyDaemonEdge,
  healthyDataEdge,
  healthySighted,
  noManagedSettings,
  HEALTHY_INSTALL_EDGE,
} from "./helpers/doctor-facts";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
const S1 = sessionIdOf("s1");

const probe = checkByName("urlHandler")!.probe;
const verdict = (urlHandler: UrlHandlerFacts) =>
  probe({ ...HEALTHY_FACTS, urlHandler });

const APP = "/Users/u/Applications/CCCandybarURLHandler.app";
const FORWARDED = { kind: "forwarder", urlV: 2 } as const;
const CLI = { kind: "cli" } as const;
const REINSTALL = "re-run `cc-candybar install`";
const FORWARDER: HandlerApp = { app: APP, forwarder: true };
const TMUX_UNDELIVERED =
  "this run was asked from the tmux status line, whose clicks tmux runs rather than the URL handler, so whether a clicked link reaches the daemon is not judged — click 🩺 doctor in the bar itself to judge it";

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

  // A run with no link to prove the handler judges what is registered, and
  // says that a click's arrival is not judged.
  test.each<[string, "tmux-status" | "command", string]>([
    ["from the tmux status line", "tmux-status", TMUX_UNDELIVERED],
    [
      "by the command",
      "command",
      notJudged("whether a clicked link reaches the daemon"),
    ],
  ])(
    "a run asked %s with the forwarder registered is ok, saying what it did not judge",
    (_, via, undelivered) => {
      expect(
        verdict({
          kind: "registered",
          via,
          opener: { kind: "ok", value: FORWARDER },
        }),
      ).toEqual({
        ok: true,
        note: `the forwarder app opens cc-candybar://; ${undelivered}`,
      });
    },
  );

  test("nothing registered is the failure", async () => {
    expect(
      verdict({
        kind: "registered",
        via: "command",
        opener: { kind: "ok", value: null },
      }),
    ).toMatchObject({
      ok: false,
      reason: `no app is registered for cc-candybar:// — ${REINSTALL}`,
    });
  });

  test("a registered opener that is not the forwarder names the app", async () => {
    expect(
      verdict({
        kind: "registered",
        via: "command",
        opener: { kind: "ok", value: { app: APP, forwarder: false } },
      }),
    ).toMatchObject({
      ok: false,
      reason: `${APP} opens cc-candybar://, but it is not the forwarder app \`cc-candybar install\` builds — ${REINSTALL}`,
    });
  });

  test("a lookup that failed is named", async () => {
    expect(
      verdict({
        kind: "registered",
        via: "tmux-status",
        opener: { kind: "failed", reason: "osascript: timeout" },
      }),
    ).toMatchObject({
      ok: false,
      reason:
        "Launch Services could not be asked which app opens cc-candybar:// — osascript: timeout",
    });
  });
});

// ─── The daemon's side ───────────────────────────────────────────────────────

describe("the daemon's side of the round trip", () => {
  const link = (delivery: Delivery): ClickArrival => ({
    via: "link",
    delivery,
  });

  // `handler` is what Launch Services answers a run that has no link to
  // prove the handler.
  function daemon(
    arrival: ClickArrival,
    handler: () => Promise<HandlerRegistration>,
  ) {
    const sessionState = new SessionState();
    const ctx: VerbContext = withDoctor(
      verbContextWith(
        testVerbContext(sessionState, undefined, DEFAULT_DSL_CONFIG),
        { arrival },
      ),
      {
        stores: emptyStores(),
        load: {
          layers: [],
          error: null,
          warnings: [],
          repo: null,
          unused: [],
          config: DEFAULT_DSL_CONFIG,
        },
      },
    );
    // The host: the session's hints as its client recorded them, and the
    // machine as a healthy one answers.
    const host = new DoctorHost(
      {
        edge: {
          install: HEALTHY_INSTALL_EDGE,
          ...healthyDaemonEdge(),
          ...healthyDataEdge(),
          ...noManagedSettings(),
          handler,
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
        },
        // From the session's own location — the origin test/helpers/click.ts
        // records, under the Claude Code directory its recorded hints name —
        // so its bar reads the click's own settings chain, never the host's.
        sighted: () =>
          healthySighted("/tmp/proj", process.env.CLAUDE_CONFIG_DIR!),
        clock: systemTimekeeper,
      },
      (session) => {
        const { live, durable } = bookedContext(sessionState, session)!;
        return { hints: live!.hints, origin: durable.origin };
      },
    );
    // A click, then the end of its turn at the host.
    const click = async (verb: string, value: string): Promise<void> => {
      clickVerb(verb, value, ctx);
      await host.settle(ctx.doctorRuns);
    };
    return { sessionState, host, click, ctx };
  }

  const KEYLESS = linkSignerOver(() => ({
    kind: "failed",
    reason: "no key can be had",
  }));

  test("a link of another scheme is refused as one, not as unsigned", () => {
    expect(parseClick("https://example.com/#top", CLI, KEYLESS)).toEqual({
      kind: "refused",
      problem: "expected a cc-candybar:// link, got: https://example.com/#top",
    });
  });

  // A link proves the handler by arriving, so Launch Services is never asked.
  const UNASKED = async (): Promise<HandlerRegistration> => {
    throw new Error("a run a link asked must not ask what is registered");
  };
  const REGISTERED = async (): Promise<HandlerRegistration> => ({
    kind: "read",
    opener: { kind: "ok", value: FORWARDER },
  });

  // In the bar, the doctor's own click is the link that came back.
  async function doctorRow(
    arrival: ClickArrival,
    handler: () => Promise<HandlerRegistration> = UNASKED,
  ) {
    const d = daemon(arrival, handler);
    // The session's own Claude Code directory (test/setup.ts's empty one):
    // with none, the doctor reads ~/.claude, the host's real settings.
    hearRender(
      d.sessionState,
      heardRequest(S1, "/tmp/proj", {
        tmux: null,
        claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
        terminalEnv: { TERM_PROGRAM: "ghostty" },
        termCols: 148,
      }),
    );
    await d.click(VERB_DOCTOR_RUN, "s1");
    const keys = doctorReportKeys("urlHandler");
    const notes = d.host.taken.filter(([key]) => key === DOCTOR_NOTE);
    expect(notes).toHaveLength(1);
    return {
      verdict: d.sessionState.get(S1, keys.verdict),
      reason: d.sessionState.get(S1, keys.reason),
      // The urlHandler verdict as the turn's record notes it.
      noted: notedReportsOf(notes[0]![1]).find((r) => r.name === "urlHandler")
        ?.verdict,
      clicked: d.host.taken.find(([key]) => key === "clicked")?.[1],
    };
  }

  test("a doctor click the forwarder delivered: the row is ok", async () => {
    const row = await doctorRow(link(FORWARDED));
    expect(row.verdict).toBe("ok");
    expect(row.noted).toEqual({ ok: true });
    expect(row.clicked).toBe("yes");
  });

  test("a doctor click a click request delivered: the row says it was not the forwarder", async () => {
    const reason = `the link was delivered by a click request (\`cc-candybar url-handle\`), not the forwarder app — ${REINSTALL}`;
    const row = await doctorRow(link(CLI));
    expect(row.verdict).toBe("failed");
    expect(row.reason).toBe(reason);
    expect(row.noted).toEqual({
      ok: false,
      reason,
      more: [],
      fixable: false,
    });
  });

  // Review of PR #405: tmux runs a status-line click itself, so it proves
  // neither the handler nor that the terminal draws links: the run judges
  // what is registered, and files no terminal.
  test("a doctor click from the tmux status line judges the registration, not the handler, and files no terminal", async () => {
    const row = await doctorRow({ via: "tmux-status" }, REGISTERED);
    expect(row.verdict).toBe("ok");
    expect(row.noted).toEqual({
      ok: true,
      note: `the forwarder app opens cc-candybar://; ${TMUX_UNDELIVERED}`,
    });
    expect(row.clicked).toBe("no");
  });

  // A [fix] or mark click on a run asked another way judges the facts as the
  // click in hand proves them: one that came by a link proves the handler.
  test("a link click on a run asked from the tmux status line proves the handler", async () => {
    const d = daemon({ via: "tmux-status" }, REGISTERED);
    hearRender(
      d.sessionState,
      heardRequest(S1, "/tmp/proj", {
        tmux: null,
        claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
        terminalEnv: { TERM_PROGRAM: "ghostty" },
        termCols: 148,
      }),
    );
    await d.click(VERB_DOCTOR_RUN, "s1");
    const now = instantAt(systemTimekeeper);
    expect(
      d.ctx.doctorRuns.facts(S1, { via: "tmux-status" }, now)?.urlHandler,
    ).toMatchObject({ kind: "registered" });
    expect(
      d.ctx.doctorRuns.facts(S1, link(FORWARDED), now)?.urlHandler,
    ).toEqual({ kind: "arrived", delivery: FORWARDED });
  });

  test("a platform with no URL handler: a run with no link is ok", async () => {
    const row = await doctorRow({ via: "tmux-status" }, async () => ({
      kind: "unsupported",
    }));
    expect(row.verdict).toBe("ok");
    expect(row.noted).toEqual({ ok: true });
  });
});
