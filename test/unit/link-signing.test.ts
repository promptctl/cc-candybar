// Every link the bar draws is signed, and the host reads a click only through
// its signature: a forged, edited or unsigned link reaches no renderer, and its
// sender is told why.

import {
  linkSigner,
  transitForm,
  unprovenLink,
  type LinkSigner,
} from "../../src/click/link-signer";
import {
  effectsUrl,
  VERB_COPY,
  VERB_REPO_CONFIG,
  VERB_RUN,
  VERB_SET_STATE,
} from "../../src/click/wire";
import { effectsOf } from "../../src/click/read";
import { parseClick } from "../../src/daemon/click-reading";
import { publishingFrames } from "../../src/daemon/foundations/frame-publication";
import type { Frame } from "../../src/render/frame";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { actionTarget, type DrawnLink } from "../../src/render/drawn-link";
import { rendererNameOf } from "../../src/daemon/foundations/renderer-name";
import { TEST_SIGNER } from "../helpers/link-signer";

const FORWARDED = { kind: "forwarder", urlV: 2 } as const;
const CLI = { kind: "cli" } as const;
const COPY = effectsUrl([{ verb: VERB_COPY, args: ["rm -rf ~"] }]);

// A signer with no key to have: what the host holds while its key file is
// broken.
const KEYLESS: LinkSigner = {
  ...TEST_SIGNER,
  openLink: () => ({ kind: "failed", reason: "no key" }),
};

describe("a link the bar draws", () => {
  test("opens to what it carries, from either delivery", () => {
    const signed = TEST_SIGNER.signLink(COPY);
    for (const delivery of [FORWARDED, CLI])
      expect(parseClick(signed, delivery, TEST_SIGNER)).toEqual({
        kind: "link",
        click: {
          scope: "global",
          verb: "dispatch",
          steps: [{ kind: "global", verb: VERB_COPY, value: "rm -rf ~" }],
        },
        runEvidence: [],
        link: COPY,
        delivery,
      });
  });

  // The OS normalizes a URL before the handler app forwards it, so the link
  // is signed as that normalization leaves it.
  test.each([
    ["a drawn click", COPY],
    ["spaces, a hash and brackets", "cc-candybar://hello world#[x]"],
    ["a bare percent", "cc-candybar://100%/x%2"],
    ["text past ASCII", "cc-candybar://copy/café ✓ 🍬"],
    ["a lone surrogate", "cc-candybar://copy/a\uD800b"],
  ])(
    "signed with %s, is a URL the WHATWG parser leaves as it is",
    (_, link) => {
      const signed = TEST_SIGNER.signLink(link);
      expect(new URL(signed).href).toBe(signed);
      expect(TEST_SIGNER.openLink(signed)).toEqual({
        kind: "ok",
        value: { href: transitForm(link) },
      });
    },
  );

  test("binds the authenticated destination to its drawing session and renderer", () => {
    const source = {
      renderer: rendererNameOf("worktree"),
      session: sessionIdOf("session# ✓"),
    };
    const signed = TEST_SIGNER.signLink(COPY, source);
    expect(new URL(signed).href).toBe(signed);
    expect(unprovenLink(signed)).toBe(COPY);
    expect(TEST_SIGNER.openLink(signed)).toEqual({
      kind: "ok",
      value: { href: COPY, source },
    });
    expect(parseClick(signed, FORWARDED, TEST_SIGNER)).toMatchObject({
      kind: "link",
      source,
      click: { scope: "global", session: source.session },
    });
    expect(
      parseClick(signed.replace("/worktree/", "/main/"), CLI, TEST_SIGNER),
    ).toMatchObject({
      kind: "refused",
      problem: expect.stringContaining("signature"),
    });
    const legacy = TEST_SIGNER.signLink(COPY);
    expect(parseClick(legacy, CLI, TEST_SIGNER)).not.toHaveProperty("source");
  });

  test("keeps what an effect list says when its readers take the mac off", () => {
    const signed = TEST_SIGNER.signLink(COPY);
    expect(transitForm(COPY)).toBe(COPY);
    expect(unprovenLink(signed)).toBe(COPY);
    expect(effectsOf(signed)).toEqual([
      { verb: VERB_COPY, args: ["rm -rf ~"] },
    ]);
  });
});

describe("a link the bar did not draw", () => {
  const signed = TEST_SIGNER.signLink(COPY);
  const refused = (url: string) => parseClick(url, FORWARDED, TEST_SIGNER);

  test("unsigned, as one in scrollback from before links were signed, is refused saying so", () => {
    expect(refused(COPY)).toEqual({
      kind: "refused",
      problem: expect.stringContaining("the link carries no signature"),
    });
  });

  test("with one byte changed, in the link or its mac, is refused", () => {
    const at = signed.indexOf("rm");
    for (const forged of [
      `${signed.slice(0, at)}RM${signed.slice(at + 2)}`,
      `${signed.slice(0, -1)}${signed.endsWith("A") ? "B" : "A"}`,
      `${signed}A`,
    ])
      expect(refused(forged)).toEqual({
        kind: "refused",
        problem: expect.stringContaining("the link's signature does not match"),
      });
  });

  test("signed by another key is refused", () => {
    const other = linkSigner(Buffer.alloc(32, 9)).signLink(COPY);
    expect(refused(other)).toEqual({
      kind: "refused",
      problem: expect.stringContaining("another key signed it"),
    });
  });

  test("is refused with the reason the host could not open it", () => {
    expect(parseClick(signed, FORWARDED, KEYLESS)).toEqual({
      kind: "refused",
      problem: "no key",
    });
  });
});

test("a retired status-line range cannot bypass signed click admission", () => {
  const range = "cc-candybar://tmux-status-click/sock/3/r1";
  for (const delivery of [CLI, FORWARDED]) {
    expect(parseClick(range, delivery, KEYLESS)).toEqual({
      kind: "refused",
      problem: "no key",
    });
  }
});

describe("a draw's frames", () => {
  const run = (text: string, link?: DrawnLink) => ({
    text,
    ...(link === undefined ? {} : { link }),
  });
  const frame = (links: Array<DrawnLink | undefined>): Frame => ({
    depth: "truecolor",
    rows: [{ kind: "bar", runs: links.map((link, i) => run(`w${i}`, link)) }],
    nextChange: Infinity,
    motion: "still",
    pending: [],
  });

  test("sign every bar link however many cells repeat it, and leave other schemes as they are", () => {
    const sign = publishingFrames(TEST_SIGNER);
    const pr = "https://github.com/o/r/pull/1";
    const drawn = [
      sign(frame([COPY, COPY, pr, undefined])),
      sign(frame([COPY])),
    ];
    expect(drawn[0]!.rows[0]!.runs.map((r) => r.link)).toEqual([
      TEST_SIGNER.signLink(COPY),
      TEST_SIGNER.signLink(COPY),
      pr,
      undefined,
    ]);
    expect(drawn[1]!.rows[0]!.runs[0]!.link).toBe(TEST_SIGNER.signLink(COPY));
  });

  test("publishes provenance only for generated targets", () => {
    const source = {
      renderer: rendererNameOf("worktree"),
      session: sessionIdOf("drawn"),
    };
    const target = actionTarget([{ verb: VERB_COPY, args: ["copy"] }]);
    const href = effectsUrl([{ verb: VERB_COPY, args: ["copy"] }]);
    const issued = TEST_SIGNER.signLink(href, source);
    const authored = issued.slice(0, issued.lastIndexOf("/"));
    const sent = publishingFrames(TEST_SIGNER)(
      frame([target, authored, "https://example.test/#fragment"]),
      source,
    );
    const links = sent.rows[0]?.runs.map((run) => run.link);
    expect(links).toEqual([
      issued,
      TEST_SIGNER.signLink(authored),
      "https://example.test/#fragment",
    ]);
    expect(TEST_SIGNER.openLink(TEST_SIGNER.signLink(authored))).toEqual({
      kind: "ok",
      value: { href: transitForm(authored) },
    });
  });

  test("refuses mismatched drawing and action sessions", () => {
    const href = effectsUrl([
      { verb: VERB_SET_STATE, args: ["another-session", "details", "closed"] },
    ]);
    const source = {
      renderer: rendererNameOf("worktree"),
      session: sessionIdOf("drawn"),
    };
    expect(
      parseClick(TEST_SIGNER.signLink(href, source), CLI, TEST_SIGNER),
    ).toMatchObject({
      kind: "refused",
      problem: expect.stringContaining("different sessions"),
    });
  });

  const session = sessionIdOf("repo-session");
  const dir = "/example/repo?a+b";
  const decision = "approved";
  const proof = TEST_SIGNER.sign({
    sessionId: session,
    action: VERB_REPO_CONFIG,
    declaration: dir,
    evaluated: decision,
  });
  const unsigned = (args: readonly string[]) =>
    effectsUrl([{ verb: VERB_REPO_CONFIG, args }]);
  const legacy = unsigned([session, dir, decision, proof]);

  test("publishes and admits a typed repository decision with identical legacy bytes", () => {
    const sign = publishingFrames(TEST_SIGNER);
    const target = {
      kind: "repo-answer",
      session,
      dir,
      answer: decision,
    } as const;
    const sent = sign(frame([target, legacy])).rows[0]?.runs.map(
      ({ link }) => link,
    );
    const signed = TEST_SIGNER.signLink(legacy);
    expect(sent).toEqual([signed, signed]);
    expect(parseClick(signed, FORWARDED, TEST_SIGNER)).toMatchObject({
      kind: "link",
      click: {
        scope: "session",
        session,
        steps: [
          {
            kind: "repo-answer",
            verb: VERB_REPO_CONFIG,
            dir,
            answer: decision,
          },
        ],
      },
    });
  });

  test.each([
    ["missing inner proof", [session, dir, decision]],
    ["wrong inner proof", [session, dir, decision, "0".repeat(64)]],
    ["another repository", [session, "/example/other", decision, proof]],
    ["another session", ["other-session", dir, decision, proof]],
    ["another answer", [session, dir, "declined", proof]],
    ["unknown answer", [session, dir, "pending", proof]],
  ])("leaves an authored repository href with %s inert", (_, args) => {
    const [run] = publishingFrames(TEST_SIGNER)(frame([unsigned(args)]))
      .rows[0]!.runs;
    expect(parseClick(run!.link!, CLI, TEST_SIGNER)).toMatchObject({
      kind: "link",
      click: {
        steps: [
          {
            kind: "invalid",
            reason: expect.stringContaining("signature does not match"),
          },
        ],
      },
    });
  });

  test("keeps the valid effects on either side of an invalid repository step", () => {
    const write = (key: string) =>
      ({ verb: VERB_SET_STATE, args: [session, key, "closed"] }) as const;
    const url = effectsUrl([
      write("one"),
      { verb: VERB_REPO_CONFIG, args: [session, dir, decision] },
      write("two"),
    ]);
    expect(
      parseClick(TEST_SIGNER.signLink(url), CLI, TEST_SIGNER),
    ).toMatchObject({
      kind: "link",
      click: {
        steps: [
          { kind: "session", verb: VERB_SET_STATE, args: ["one", "closed"] },
          { kind: "invalid" },
          { kind: "session", verb: VERB_SET_STATE, args: ["two", "closed"] },
        ],
      },
    });
  });

  test("indexes each drawn run separately and retains its signing evidence in the host", () => {
    const action = "export";
    const declaration = "registered action";
    const captures = ["earlier", "later"].map((value) => {
      const evaluated = JSON.stringify({ run: ["/bin/true", value], env: {} });
      const mac = TEST_SIGNER.sign({
        sessionId: session,
        action,
        declaration,
        evaluated,
      });
      return { session, action, evaluated, mac };
    });
    const raw = effectsUrl(
      captures.map((run) => ({
        verb: VERB_RUN,
        args: [run.session, run.action, run.evaluated, run.mac],
      })),
    );
    const admitted = parseClick(TEST_SIGNER.signLink(raw), CLI, TEST_SIGNER);
    if (admitted.kind !== "link") throw new Error(admitted.problem);
    expect(admitted.click.steps).toEqual([
      { kind: "run", verb: VERB_RUN, action, capture: 0 },
      { kind: "run", verb: VERB_RUN, action, capture: 1 },
    ]);
    expect(admitted.runEvidence).toEqual(captures);
  });
});
