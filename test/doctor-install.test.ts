// [LAW:verifiable-goals] brandon-doctor-v62x.tfb: "the install is current" —
// the bar is drawn by the native client of the install the daemon runs from,
// built from the source beside it. The probe is pure over InstallFacts; the
// fold from what the daemon saw to those facts (installFacts), the CLI's read
// of daemon-stats (parseDaemonClients), the daemon's record of each session's
// latest client (ClientSightings) and the hint's checkpoint are each pinned
// here.

import { installOf } from "../src/doctor/cli";
import { RECENT_CLIENT_S } from "../src/doctor/checks";
import { RuntimeStats, type StatsSnapshot } from "../src/daemon/stats";
import { shapeSkew } from "../src/daemon/client-stats";
import {
  checkByName,
  type ClientFact,
  type DaemonInstall,
  type DoctorFacts,
  type InstallFacts,
} from "../src/doctor/checks";
import { installFacts, type InstallEdge } from "../src/doctor/edge";
import { installFields } from "../src/doctor/report";
import { parseDaemonClients } from "../src/doctor/daemon-clients";
import { ClientSightings, SIGHTINGS_KEPT } from "../src/daemon/client-sightings";
import { parseClientHints } from "../src/daemon/protocol";
import type { Instant } from "../src/utils/instant";
import { HEALTHY_FACTS, HEALTHY_INSTALL_EDGE } from "./helpers/doctor-facts";

const BUNDLE = "/opt/cc/dist/index.mjs";
const ROOT = "/src/cc";
const CHECKOUT_BUNDLE = `${ROOT}/dist/index.mjs`;
const PUBLISHED: DaemonInstall = { bundle: BUNDLE, checkout: null };
const CHECKOUT: DaemonInstall = {
  bundle: CHECKOUT_BUNDLE,
  checkout: { root: ROOT, rustSource: { kind: "ok", value: "abc" } },
};

const native = (bundle: string, source: string | null = null): ClientFact => ({
  kind: "reported",
  client: "native",
  bundle: { kind: "ok", value: bundle },
  source,
});

function verdict(
  daemon: DaemonInstall,
  clients: readonly ClientFact[],
  nativeShipped = true,
) {
  const install: InstallFacts = {
    kind: "ok",
    value: { daemon, nativeShipped, clients },
  };
  const facts: DoctorFacts = { ...HEALTHY_FACTS, install };
  return checkByName("install")!.probe(facts);
}

describe("install probe", () => {
  test("the published native client beside the daemon's bundle is ok", () => {
    expect(verdict(PUBLISHED, [native(BUNDLE)])).toEqual({ ok: true });
  });

  test("a checkout's native client built from its Rust source is ok", () => {
    expect(verdict(CHECKOUT, [native(CHECKOUT_BUNDLE, "abc")])).toEqual({
      ok: true,
    });
  });

  test("a client too old to report is named, with the install's remedy", () => {
    expect(verdict(PUBLISHED, [{ kind: "unreported" }])).toEqual({
      ok: false,
      reason:
        "the bar is drawn by a statusline client too old to say what it is — re-run `cc-candybar install`",
      more: [],
    });
    expect(verdict(CHECKOUT, [{ kind: "unreported" }])).toEqual({
      ok: false,
      reason: `the bar is drawn by a statusline client too old to say what it is — run \`just install-rust\` and point the statusLine command at ${ROOT}/bin/cc-candybar-native`,
      more: [],
    });
  });

  test("a client of another bundle names both", () => {
    expect(verdict(PUBLISHED, [native("/old/dist/index.mjs")])).toEqual({
      ok: false,
      reason: `the statusline client runs /old/dist/index.mjs, not the daemon's ${BUNDLE} — re-run \`cc-candybar install\``,
      more: [],
    });
    expect(verdict(CHECKOUT, [native("/old/dist/index.mjs", "abc")])).toEqual(
      {
        ok: false,
        reason: `the statusline client runs /old/dist/index.mjs, not the daemon's ${CHECKOUT_BUNDLE} — run \`just install-rust\` and point the statusLine command at ${ROOT}/bin/cc-candybar-native`,
        more: [],
      },
    );
    expect(
      verdict(CHECKOUT, [
        {
          kind: "reported",
          client: "frames",
          bundle: { kind: "ok", value: "/old/dist/index.mjs" },
          source: null,
        },
      ]),
    ).toEqual({
      ok: false,
      reason: `the statusline client runs /old/dist/index.mjs, not the daemon's ${CHECKOUT_BUNDLE} — run \`node ${CHECKOUT_BUNDLE} frames\``,
      more: [],
    });
    // Re-installing stages the same files and changes nothing a frames
    // client runs, so a published install's is told the daemon's bundle too.
    expect(
      verdict(PUBLISHED, [
        {
          kind: "reported",
          client: "frames",
          bundle: { kind: "ok", value: "/global/dist/index.mjs" },
          source: null,
        },
      ]),
    ).toEqual({
      ok: false,
      reason: `the statusline client runs /global/dist/index.mjs, not the daemon's ${BUNDLE} — run \`node ${BUNDLE} frames\``,
      more: [],
    });
  });

  test("a bundle that cannot be resolved is the finding", () => {
    expect(
      verdict(PUBLISHED, [
        {
          kind: "reported",
          client: "native",
          bundle: { kind: "failed", reason: "ENOENT: no such file" },
          source: null,
        },
      ]),
    ).toEqual({
      ok: false,
      reason:
        "the statusline client's bundle cannot be resolved: ENOENT: no such file",
      more: [],
    });
  });

  const node = (kind: "node" | "frames", bundle: string): ClientFact => ({
    kind: "reported",
    client: kind,
    bundle: { kind: "ok", value: bundle },
    source: null,
  });

  test("the Node fallback fails where a native client ships, and only there", () => {
    expect(verdict(PUBLISHED, [node("node", BUNDLE)])).toEqual({
      ok: false,
      reason:
        "the bar is drawn by the Node fallback, which starts node on every render — re-run `cc-candybar install`",
      more: [],
    });
    expect(verdict(PUBLISHED, [node("node", BUNDLE)], false)).toEqual({
      ok: true,
    });
  });

  test("in a checkout the Node fallback fails on any platform: `just install-rust` builds a native client", () => {
    expect(verdict(CHECKOUT, [node("node", CHECKOUT_BUNDLE)], false)).toEqual({
      ok: false,
      reason:
        `the bar is drawn by the Node fallback, which starts node on every render — run \`just install-rust\` and point the statusLine command at ${ROOT}/bin/cc-candybar-native`,
      more: [],
    });
  });

  test("`cc-candybar frames` is Node by design, never the fallback", () => {
    expect(verdict(CHECKOUT, [node("frames", CHECKOUT_BUNDLE)])).toEqual({
      ok: true,
    });
  });

  test("a checkout's native client built from other source, or with no stamp, says so", () => {
    expect(verdict(CHECKOUT, [native(CHECKOUT_BUNDLE, "old")])).toEqual({
      ok: false,
      reason: `the native client was built from other source than ${ROOT}/rust-client holds — run \`just install-rust\``,
      more: [],
    });
    expect(verdict(CHECKOUT, [native(CHECKOUT_BUNDLE, null)])).toEqual({
      ok: false,
      reason:
        "the native client carries no source stamp, so which source it was built from is unknown — run `just install-rust`",
      more: [],
    });
  });

  test("Rust source that cannot be read is the finding, not a guess", () => {
    const unreadable: DaemonInstall = {
      bundle: CHECKOUT_BUNDLE,
      checkout: {
        root: ROOT,
        rustSource: { kind: "failed", reason: "EACCES" },
      },
    };
    expect(verdict(unreadable, [native(CHECKOUT_BUNDLE, "abc")])).toEqual({
      ok: false,
      reason: `${ROOT}/rust-client could not be read: EACCES`,
      more: [],
    });
  });

  test("no client to judge is the finding, worded for who asked", () => {
    expect(verdict(PUBLISHED, [])).toEqual({
      ok: false,
      reason:
        "no statusline client has drawn a bar for this daemon in the last 5 minutes — run the doctor again once the bar has redrawn; if it never does, the statusLine command does not run cc-candybar",
    });
    const install: InstallFacts = {
      kind: "ok",
      value: { daemon: PUBLISHED, nativeShipped: true, clients: [] },
    };
    expect(
      checkByName("install")!.probe({ ...HEALTHY_FACTS, install, askedBy: "click" }),
    ).toEqual({
      ok: false,
      reason:
        "the daemon restarted since this bar was drawn, so which client draws it is unknown — run the doctor again once the bar has redrawn",
    });
  });

  test("sessions sharing a problem share one line; different problems each get one", () => {
    expect(
      verdict(PUBLISHED, [
        { kind: "unreported" },
        { kind: "unreported" },
        native("/old/dist/index.mjs"),
      ]),
    ).toEqual({
      ok: false,
      reason:
        "the bar is drawn by a statusline client too old to say what it is — re-run `cc-candybar install`",
      more: [
        `the statusline client runs /old/dist/index.mjs, not the daemon's ${BUNDLE} — re-run \`cc-candybar install\``,
      ],
    });
  });

  test("a daemon that could not be asked is the finding", () => {
    const facts: DoctorFacts = {
      ...HEALTHY_FACTS,
      install: { kind: "failed", reason: "no daemon is running" },
    };
    expect(checkByName("install")!.probe(facts)).toEqual({
      ok: false,
      reason:
        "the daemon could not be asked which clients draw the bar: no daemon is running",
    });
  });
});

describe("installFacts: the fold from what the daemon saw", () => {
  // A checkout whose bin/ is a symlink: every path resolves through it.
  const edge: InstallEdge = {
    realpath: (p) =>
      p.includes("missing")
        ? { kind: "failed", reason: `ENOENT: ${p}` }
        : { kind: "ok", value: p.replace("/link/bin/../", `${ROOT}/`) },
    checkoutOf: (b) => (b.startsWith(ROOT) ? ROOT : null),
    digest: (dir) => ({ kind: "ok", value: `digest of ${dir}` }),
    nativeShipped: true,
  };

  test("both bundles resolve through every link, and a checkout carries its Rust digest", () => {
    expect(
      installFacts(edge, "/link/bin/../dist/index.mjs", [
        { kind: "native", bundle: "/link/bin/../dist/index.mjs", source: "s" },
        null,
        { kind: "node", bundle: "/missing/index.mjs", source: null },
      ]),
    ).toEqual({
      kind: "ok",
      value: {
        daemon: {
          bundle: CHECKOUT_BUNDLE,
          checkout: {
            root: ROOT,
            rustSource: {
              kind: "ok",
              value: `digest of ${ROOT}/rust-client`,
            },
          },
        },
        nativeShipped: true,
        clients: [
          native(CHECKOUT_BUNDLE, "s"),
          { kind: "unreported" },
          {
            kind: "reported",
            client: "node",
            bundle: { kind: "failed", reason: "ENOENT: /missing/index.mjs" },
            source: null,
          },
        ],
      },
    });
  });

  test("a published bundle carries no checkout; one that does not resolve fails the facts", () => {
    const published = installFacts(HEALTHY_INSTALL_EDGE, BUNDLE, []);
    expect(published).toEqual({
      kind: "ok",
      value: {
        daemon: { bundle: BUNDLE, checkout: null },
        nativeShipped: true,
        clients: [],
      },
    });
    expect(installFacts(edge, "/missing/dist/index.mjs", [])).toEqual({
      kind: "failed",
      reason:
        "the daemon's bundle /missing/dist/index.mjs cannot be resolved: ENOENT: /missing/dist/index.mjs",
    });
  });
});

describe("installFields: the doctor's event", () => {
  test("each client judged, by kind and standing", () => {
    expect(
      installFields({
        kind: "ok",
        value: {
          daemon: CHECKOUT,
          nativeShipped: true,
          clients: [
            native(CHECKOUT_BUNDLE, "abc"),
            native(CHECKOUT_BUNDLE, "old"),
            native(CHECKOUT_BUNDLE, null),
            native("/old/dist/index.mjs"),
            { kind: "unreported" },
          ],
        },
      }),
    ).toBe(
      "clients=native/same/same,native/same/other,native/same/unstamped,native/other/unstamped,unreported/-/-",
    );
    expect(
      installFields({
        kind: "ok",
        value: { daemon: PUBLISHED, nativeShipped: true, clients: [] },
      }),
    ).toBe("clients=-");
    expect(installFields({ kind: "failed", reason: "x" })).toBe(
      "clients=unasked",
    );
  });
});

describe("installOf: the clients the command judges", () => {
  test("only a session that drew within the window is one the bar runs", () => {
    const stale = { kind: "native", bundle: "/old/dist/index.mjs", source: null } as const;
    const current = { kind: "native", bundle: BUNDLE, source: null } as const;
    const facts = installOf(HEALTHY_INSTALL_EDGE, {
      kind: "ok",
      value: {
        bundle: BUNDLE,
        clients: [
          { client: stale, ago: RECENT_CLIENT_S + 1 },
          { client: current, ago: RECENT_CLIENT_S },
        ],
      },
    });
    expect(facts.kind === "ok" && facts.value.clients).toEqual([native(BUNDLE)]);
  });
});

describe("parseDaemonClients: the CLI's read of daemon-stats", () => {
  // A snapshot of this build's shape, as the daemon would send it.
  const stats = (fields: object): StatsSnapshot =>
    ({ ...RuntimeStats.referenceSnapshot(), version: "1.0.0", ...fields }) as StatsSnapshot;

  test("a sighting's client crosses the hint checkpoint; a malformed one is unreported", () => {
    expect(
      parseDaemonClients(stats({
        bundle: BUNDLE,
        clients: [
          { client: { kind: "native", bundle: BUNDLE, source: null }, ago: 2 },
          { client: { kind: "native", bundle: "relative", source: null }, ago: 1 },
          { client: null, ago: 0 },
        ],
      })),
    ).toEqual({
      kind: "ok",
      value: {
        bundle: BUNDLE,
        clients: [
          { client: { kind: "native", bundle: BUNDLE, source: null }, ago: 2 },
          { client: null, ago: 1 },
          { client: null, ago: 0 },
        ],
      },
    });
  });

  test("a daemon of another build, or one reporting no age, is refused", () => {
    const { clients: _clients, ...rest } = stats({});
    const older = rest as StatsSnapshot;
    const asked = parseDaemonClients(older);
    expect(asked).toEqual({
      kind: "failed",
      reason: shapeSkew(older, ["bundle", "clients"]),
    });
    expect(asked.kind === "failed" && asked.reason).toMatch(/reports no clients;/);
    expect(
      parseDaemonClients(stats({ bundle: BUNDLE, clients: [{ client: null }] })),
    ).toEqual({
      kind: "failed",
      reason:
        'the running daemon (1.0.0) reported clients without their age: [{"client":null}]',
    });
  });
});

describe("ClientSightings: each session's latest client", () => {
  const at = (s: number) => s as Instant;
  const client = (bundle: string) =>
    ({ kind: "native", bundle, source: null }) as const;

  test("a session's next render replaces its client at once", () => {
    const sightings = new ClientSightings();
    sightings.see("s1", client("/old/dist/index.mjs"), at(100));
    sightings.see("s1", client(BUNDLE), at(105));
    sightings.see("s2", undefined, at(103));
    expect(sightings.list(at(110))).toEqual([
      { client: client(BUNDLE), ago: 5 },
      { client: null, ago: 7 },
    ]);
  });

  test("a click reads its own session's sighting, and none this process has not seen", () => {
    const sightings = new ClientSightings();
    sightings.see("s1", client(BUNDLE), at(100));
    sightings.see("s2", undefined, at(104));
    expect(sightings.ofSession("s1")).toEqual([client(BUNDLE)]);
    expect(sightings.ofSession("restarted-under-me")).toEqual([]);
  });

  test("two clients drawing one session are both kept: the last to render hides neither", () => {
    const sightings = new ClientSightings();
    const frames = { kind: "frames", bundle: BUNDLE, source: null } as const;
    sightings.see("s1", client("/stale/dist/index.mjs"), at(100));
    sightings.see("s1", frames, at(101));
    sightings.see("s1", frames, at(102));
    expect(sightings.ofSession("s1")).toEqual([
      client("/stale/dist/index.mjs"),
      frames,
    ]);
    expect(sightings.list(at(110))).toHaveLength(2);
    // A rebuilt statusline client replaces the old one in the same role.
    sightings.see("s1", undefined, at(103));
    expect(sightings.ofSession("s1")).toEqual([frames, null]);
  });

  test("the sessions longest without a render are the ones dropped", () => {
    const sightings = new ClientSightings();
    for (let i = 0; i <= SIGHTINGS_KEPT; i++) {
      sightings.see(`s${i}`, undefined, at(i));
    }
    const kept = sightings.list(at(1000));
    expect(kept).toHaveLength(SIGHTINGS_KEPT);
    expect(kept[0]).toEqual({ client: null, ago: 999 });
  });
});

describe("the client hint at the checkpoint", () => {
  test("a well-formed hint passes; any malformed field refuses it whole", () => {
    const good = { kind: "native", bundle: BUNDLE, source: "abc" };
    expect(parseClientHints({ client: good }).client).toEqual(good);
    for (const bad of [
      { ...good, kind: "rust" },
      { ...good, bundle: "dist/index.mjs" },
      { ...good, source: "" },
      { ...good, source: 7 },
      "native",
      null,
    ]) {
      expect(parseClientHints({ client: bad }).client).toBeUndefined();
    }
  });
});
