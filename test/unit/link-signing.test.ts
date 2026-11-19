// Every link the bar draws is signed, and the host reads a click only through
// its signature: a forged, edited or unsigned link reaches no renderer, and its
// sender is told why.

import {
  linkSigner,
  signingFrames,
  transitForm,
  unprovenLink,
  type LinkSigner,
} from "../../src/click/link-signer";
import { effectsUrl, VERB_COPY } from "../../src/click/wire";
import { effectsOf } from "../../src/click/read";
import { parseClick } from "../../src/daemon/click-reading";
import type { Frame } from "../../src/render/frame";
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
        value: transitForm(link),
      });
    },
  );

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
  const run = (text: string, link?: string) => ({
    text,
    ...(link === undefined ? {} : { link }),
  });
  const frame = (links: Array<string | undefined>): Frame => ({
    depth: "truecolor",
    rows: [{ kind: "bar", runs: links.map((link, i) => run(`w${i}`, link)) }],
    nextChange: Infinity,
    motion: "still",
    pending: [],
  });

  test("sign every bar link however many cells repeat it, and leave other schemes as they are", () => {
    const sign = signingFrames(TEST_SIGNER);
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
});
