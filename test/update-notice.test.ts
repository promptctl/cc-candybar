// [LAW:behavior-not-structure] The pure core of the update notice
// (brandon-build-notice-5d6): which currency facts become an Update, what a
// dismissal names, the sentence and the three affordances a session sees,
// and how the act's state changes the row — measured on the channels and on
// the composed strip, by what each click DOES.

import {
  collectDiagnostics,
  UPDATE_SEVERITY,
  viewerRows,
} from "../src/render/diagnostics";
import { plainOf } from "../src/render/frame";
import {
  describeStamp,
  factsOf,
  updateIdentity,
  updateNotice,
  updateOf,
  UPDATE_DISMISSED_KEY,
  UPDATE_NOTICE_FIELD,
  UPDATE_NOTICE_SESSION_KEY,
  type Update,
} from "../src/daemon/update-notice";
import type { ActState } from "../src/daemon/update-act";
import type { BuildCurrency, SourceStamp } from "../src/daemon/build-currency";
import type { Currency } from "../src/install/currency";
import { effectsOf as decode } from "./helpers/click";

// A span's click, decoded; a plain span has none.
const clicksOf = (link: string | null) => (link === null ? [] : decode(link));

const NEWER: SourceStamp = {
  version: "9.9.9",
  digest: "abcdef0123456789".repeat(4),
};
const RUNNING: SourceStamp = {
  version: "1.0.0",
  digest: "0123456789abcdef".repeat(4),
};
const ROOT = "/checkout";
const SOURCE: Update = {
  kind: "source",
  root: ROOT,
  newer: NEWER,
  running: RUNNING,
};
const RELEASE: Update = {
  kind: "release",
  newer: [99, 0, 0],
  running: [1, 2, 3],
};

const STALE_BUILD: BuildCurrency = {
  kind: "stale",
  root: ROOT,
  source: NEWER,
  running: RUNNING,
};
const CURRENT_BUILD: BuildCurrency = {
  kind: "current",
  root: ROOT,
  stamp: RUNNING,
};
const INSTALL: BuildCurrency = { kind: "not-source-checkout" };
const STALE_RELEASE: Currency = {
  kind: "stale",
  installed: [1, 2, 3],
  latest: [99, 0, 0],
};
const CURRENT_RELEASE: Currency = { kind: "current", installed: [1, 2, 3] };

const SID = "sess-1";
const ctx = (over: Partial<Parameters<typeof updateNotice>[2]> = {}) => ({
  sessionId: SID,
  dismissed: null,
  enabled: true,
  ...over,
});

describe("updateOf", () => {
  test("a stale checkout is a source update; the registry is not its business", () => {
    expect(updateOf(STALE_BUILD, STALE_RELEASE)).toEqual(SOURCE);
    expect(updateOf(CURRENT_BUILD, STALE_RELEASE)).toBeNull();
  });

  test("a published install behind the registry is a release update", () => {
    expect(updateOf(INSTALL, STALE_RELEASE)).toEqual(RELEASE);
    expect(updateOf(INSTALL, CURRENT_RELEASE)).toBeNull();
    expect(updateOf(INSTALL, null)).toBeNull();
  });

  test("an unchecked build is nothing to notice", () => {
    expect(
      updateOf({ kind: "unchecked", reason: "x" }, STALE_RELEASE),
    ).toBeNull();
  });
});

describe("identity and facts", () => {
  test("a dismissal names the digest for source, the version for a release", () => {
    expect(updateIdentity(SOURCE)).toBe(NEWER.digest);
    expect(updateIdentity(RELEASE)).toBe("99.0.0");
  });

  test("the act is the command the provenance implies, never data from a click", () => {
    expect(factsOf(SOURCE).command).toEqual({
      bin: "pnpm",
      args: ["build"],
      cwd: ROOT,
    });
    expect(factsOf(RELEASE).command).toEqual({
      bin: "pnpm",
      args: ["dlx", "@promptctl/cc-candybar@99.0.0", "install"],
    });
    expect(describeStamp(NEWER)).toBe("9.9.9 [abcdef0]");
  });
});

describe("updateNotice", () => {
  test("nothing newer, a disabled config, or a matching dismissal: no channel", () => {
    expect(updateNotice(null, { kind: "idle" }, ctx())).toEqual([]);
    expect(
      updateNotice(SOURCE, { kind: "idle" }, ctx({ enabled: false })),
    ).toEqual([]);
    expect(
      updateNotice(SOURCE, { kind: "idle" }, ctx({ dismissed: NEWER.digest })),
    ).toEqual([]);
  });

  test("a dismissal of something else has lapsed: the notice is back", () => {
    expect(
      updateNotice(
        SOURCE,
        { kind: "idle" },
        ctx({ dismissed: "older-digest" }),
      ),
    ).toHaveLength(1);
  });

  test("one sentence naming newer and running, then act / dismiss / disable, each its own click", () => {
    const [ch] = updateNotice(SOURCE, { kind: "idle" }, ctx());
    expect(ch!.severity).toBe(UPDATE_SEVERITY);
    expect(ch!.message).toBe(
      "Newer source: 9.9.9 [abcdef0]. You're on 1.0.0 [0123456].",
    );
    const [line] = ch!.lines;
    expect(line.map((s) => s.text)).toEqual([
      ch!.message,
      "[rebuild]",
      "[dismiss]",
      "[disable]",
    ]);
    const [sentence, act, dismiss, disable] = line;
    // The sentence is plain text: the viewer's ⧉ copies it.
    expect(sentence!.link).toBeNull();
    expect(clicksOf(act!.link)).toEqual([
      { verb: "apply-update", args: [SID] },
    ]);
    expect(clicksOf(dismiss!.link)).toEqual([
      { verb: "set-state", args: [SID, UPDATE_DISMISSED_KEY, NEWER.digest] },
    ]);
    expect(clicksOf(disable!.link)).toEqual([
      { verb: "set-config", args: [SID, UPDATE_NOTICE_FIELD, "false"] },
      { verb: "set-state", args: [SID, UPDATE_NOTICE_SESSION_KEY, "false"] },
    ]);
  });

  test("a release reads the same way with its own words", () => {
    const [ch] = updateNotice(RELEASE, { kind: "idle" }, ctx());
    expect(ch!.message).toBe("Newer release: 99.0.0. You're on 1.2.3.");
    expect(ch!.lines[0][1]!.text).toBe("[upgrade]");
    expect(clicksOf(ch!.lines[0][2]!.link)[0]!.args[2]).toBe("99.0.0");
  });

  test("while the act runs its affordance is a busy label with no apply click", () => {
    const [ch] = updateNotice(SOURCE, { kind: "running", act: 1 }, ctx());
    expect(ch!.lines[0][1]!.text).toBe("[rebuilding…]");
    const verbs = ch!.lines
      .flat()
      .flatMap((s) => clicksOf(s.link).map((e) => e.verb));
    expect(verbs).not.toContain("apply-update");
  });

  const FAILED: ActState = {
    kind: "failed",
    act: 1,
    identity: updateIdentity(SOURCE),
    reason: "non-zero (exit 1): boom",
  };

  test("a failed act adds a second line naming the failure, and offers the act again", () => {
    const [ch] = updateNotice(SOURCE, FAILED, ctx());
    expect(ch!.lines).toHaveLength(2);
    expect(ch!.lines[1]![0]!.text).toBe(
      "rebuild failed: non-zero (exit 1): boom",
    );
    expect(ch!.lines[0][1]!.text).toBe("[rebuild]");
    expect(ch!.message).toBe(
      "Newer source: 9.9.9 [abcdef0]. You're on 1.0.0 [0123456].\nrebuild failed: non-zero (exit 1): boom",
    );
  });

  test("a failure names the attempt it came from: a different newer thing shows no failure line", () => {
    const newerStill: Update = {
      ...SOURCE,
      newer: { version: "9.9.10", digest: "fedcba9876543210".repeat(4) },
    };
    const [ch] = updateNotice(newerStill, FAILED, ctx());
    expect(ch!.lines).toHaveLength(1);
    expect(ch!.message).toBe(
      "Newer source: 9.9.10 [fedcba9]. You're on 1.0.0 [0123456].",
    );
  });

  test("drawn: the row reads as the sentence and its three clicks, each linked to its own effect", () => {
    const [message] = updateNotice(SOURCE, { kind: "idle" }, ctx());
    const list = collectDiagnostics("s", "request", [], [message!], []);
    const [, ...rows] = viewerRows(
      list,
      { index: 1, page: 0 },
      "s",
      "request",
      {
        width: 200,
        rows: 20,
        colorCompatibility: "truecolor",
      },
    );
    expect(rows.map((row) => plainOf(row.runs))).toEqual([
      "⬆ Newer source: 9.9.9 [abcdef0]. You're on 1.0.0 [0123456]. [rebuild] [dismiss] [disable] ",
    ]);
    const verbs = rows
      .flatMap((row) => row.runs)
      .flatMap(({ link }) => clicksOf(link ?? null).map((e) => e.verb));
    expect(new Set(verbs)).toEqual(
      new Set(["apply-update", "set-state", "set-config"]),
    );
  });
});
