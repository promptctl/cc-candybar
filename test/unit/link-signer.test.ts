// A link the bar draws proves the bar drew it: any web page can open a
// `cc-candybar://` link, so the host honours only one whose mac verifies.

import { linkSigner, unprovenLink } from "../../src/click/link-signer";
import { TEST_SIGNER } from "../helpers/link-signer";

const LINK = "cc-candybar://dispatch/does=copy+hello&e=copy%2Fhello%20world";

describe("a signed link", () => {
  const signed = TEST_SIGNER.signLink(LINK);

  test("verifies as the link it signs", () => {
    expect(TEST_SIGNER.verifyLink(signed)).toEqual({ ok: true, link: LINK });
  });

  test("keeps the link's words first, where a terminal's hover shows them", () => {
    expect(signed.startsWith(LINK)).toBe(true);
  });

  test.each([...Array(signed.length).keys()])(
    "with the byte at %i changed is refused",
    (at) => {
      const flipped =
        signed.slice(0, at) +
        (signed[at] === "A" ? "B" : "A") +
        signed.slice(at + 1);
      expect(TEST_SIGNER.verifyLink(flipped)).toEqual({
        ok: false,
        problem: expect.stringMatching(/signature/),
      });
    },
  );

  test("with text after its mac is refused", () => {
    expect(TEST_SIGNER.verifyLink(`${signed}x`).ok).toBe(false);
  });

  test("under another key is refused", () => {
    const other = linkSigner(Buffer.alloc(32, 1));
    expect(other.verifyLink(signed)).toEqual({
      ok: false,
      problem: expect.stringMatching(/does not match/),
    });
  });
});

describe("a link carrying text a URL parser escapes", () => {
  // A config's own link, written without urlEncode: a second `#`, a space and
  // non-ASCII text, each of which a terminal or Foundation escapes on its way.
  const RAW = "cc-candybar://copy/fix/#12-x y é";
  const signed = TEST_SIGNER.signLink(RAW);

  test("is signed in a form a URL parser keeps byte for byte", () => {
    expect(new URL(signed).href).toBe(signed);
  });

  test("verifies as the link it names, once its escapes are read", () => {
    const verified = TEST_SIGNER.verifyLink(new URL(signed).href);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(decodeURIComponent(verified.link)).toBe(RAW);
  });
});

test("a link carrying half a character signs, with the half drawn as U+FFFD", () => {
  const verified = TEST_SIGNER.verifyLink(
    TEST_SIGNER.signLink("cc-candybar://copy/cut\uD83D"),
  );
  expect(verified.ok).toBe(true);
  if (verified.ok)
    expect(decodeURIComponent(verified.link)).toBe(
      "cc-candybar://copy/cut�",
    );
});

describe("a link with no mac", () => {
  test("is refused, saying it carries none", () => {
    expect(TEST_SIGNER.verifyLink(LINK)).toEqual({
      ok: false,
      problem: expect.stringMatching(/carries no signature/),
    });
  });
});

describe("a drawn link read without the key", () => {
  test("is the link with its mac removed", () => {
    expect(unprovenLink(TEST_SIGNER.signLink(LINK))).toBe(LINK);
  });

  test("of no mac is itself", () => {
    expect(unprovenLink(LINK)).toBe(LINK);
  });
});
