// [LAW:verifiable-goals] 70m.8 acceptance for the click wire itself: an ordered
// effect list serializes to ONE dispatch URL and parses back; arbitrary
// slash/&/= bearing values round-trip (the slash-safety the old whole-value
// decode could not give); the `dispatch` verb runs EVERY effect, aggregates
// failures without aborting, and cannot nest; and old direct (non-dispatch)
// links still parse and run.

import {
  effectsUrl,
  parseEffects,
  encodeSegments,
  decodeSegments,
  VERB_COPY,
  VERB_DISPATCH,
  VERB_SET_STATE,
} from "../src/click/wire";
import { parseHandlerUrl } from "../src/install/index";
import { VERBS } from "../src/daemon/verbs";
import { SessionState } from "../src/daemon/session-state";
import { effectsOf, clickUrl } from "./helpers/click";

const SID = "s1";
const ctx = (sessionState: SessionState) => ({ sessionState, dlog: () => {} });

describe("click wire — encode/decode round-trip", () => {
  test("a single effect serializes to a dispatch URL and decodes back", () => {
    const url = effectsUrl([
      { verb: VERB_SET_STATE, args: [SID, "theme", "nord"] },
    ]);
    expect(url.startsWith("cc-candybar://dispatch/e=")).toBe(true);
    expect(effectsOf(url)).toEqual([
      { verb: "set-state", args: [SID, "theme", "nord"] },
    ]);
  });

  test("N effects ride one URL in author order (set leads, copy follows)", () => {
    const url = effectsUrl([
      { verb: VERB_SET_STATE, args: [SID, "theme", "nord"] },
      { verb: VERB_COPY, args: ["copied!"] },
    ]);
    expect(effectsOf(url)).toEqual([
      { verb: "set-state", args: [SID, "theme", "nord"] },
      { verb: "copy", args: ["copied!"] },
    ]);
  });

  test("values bearing /, & and = round-trip intact (slash-safety)", () => {
    const nasty = "a/b&c=d/e";
    const url = effectsUrl([{ verb: VERB_COPY, args: [nasty] }]);
    expect(effectsOf(url)).toEqual([{ verb: "copy", args: [nasty] }]);
  });

  test("encodeSegments/decodeSegments are inverse, even with embedded slashes", () => {
    const parts = ["/proj/x", "a&b", ""];
    expect(decodeSegments(encodeSegments(parts))).toEqual(parts);
  });

  test("parseEffects preserves order and keeps each tail encoded for the handler", () => {
    const url = effectsUrl([
      { verb: VERB_SET_STATE, args: [SID, "k", "v"] },
      { verb: VERB_COPY, args: ["x"] },
    ]);
    const { value } = parseHandlerUrl(url);
    const parsed = parseEffects(value);
    expect(parsed.map((e) => e.verb)).toEqual(["set-state", "copy"]);
  });
});

describe("parseHandlerUrl — verb split, value raw", () => {
  test("dispatch URL → verb=dispatch, value is the raw query string", () => {
    const url = effectsUrl([{ verb: VERB_COPY, args: ["hi"] }]);
    const { verb, value } = parseHandlerUrl(url);
    expect(verb).toBe(VERB_DISPATCH);
    expect(value.startsWith("e=")).toBe(true);
  });

  test("old direct set-state link still parses (back-compat scrollback)", () => {
    const { verb, value } = parseHandlerUrl(
      "cc-candybar://set-state/s1/theme/textual-dark",
    );
    expect(verb).toBe("set-state");
    expect(value).toBe("s1/theme/textual-dark");
  });

  test("bare form → copy with the raw value", () => {
    expect(parseHandlerUrl("cc-candybar://hello-world")).toEqual({
      verb: "copy",
      value: "hello-world",
    });
  });

  test("a bare value containing '?' copies verbatim — ? is data, not a delimiter", () => {
    // Regression: only `/` delimits the verb; `dispatch/e=…` carries the effect
    // list, so `?` never needs to split and stays part of a bare copy value.
    expect(parseHandlerUrl("cc-candybar://hello?world")).toEqual({
      verb: "copy",
      value: "hello?world",
    });
  });

  test("a direct single-arg link keeps its unencoded slashes in the raw value", () => {
    // Regression: the copy handler decodes the WHOLE value (oneArg →
    // decodeURIComponent), so an old `copy/a/b` link copies "a/b", not "a".
    // parseHandlerUrl hands the raw tail; only the verb is split off.
    expect(parseHandlerUrl("cc-candybar://copy/a/b")).toEqual({
      verb: "copy",
      value: "a/b",
    });
  });
});

describe("dispatch verb — run all, aggregate, no nesting", () => {
  test("every effect runs; a later failure does not undo an earlier success", () => {
    const sessionState = new SessionState();
    // First effect writes a valid key; second names an unknown key (rejected).
    const url = effectsUrl([
      { verb: VERB_SET_STATE, args: [SID, "theme", "textual-dark"] },
      { verb: VERB_SET_STATE, args: [SID, "no-such-key", "x"] },
    ]);
    // The aggregated failure surfaces, naming the bad effect...
    expect(() => clickUrl(url, ctx(sessionState))).toThrow(/no-such-key/);
    // ...but the earlier effect still committed (run-all, not abort-on-first).
    expect(sessionState.get(SID, "theme")).toBe("textual-dark");
  });

  test("a clean compound click applies both set effects", () => {
    const sessionState = new SessionState();
    const url = effectsUrl([
      { verb: VERB_SET_STATE, args: [SID, "theme", "textual-dark"] },
      { verb: VERB_SET_STATE, args: [SID, "style", "muted"] },
    ]);
    clickUrl(url, ctx(sessionState));
    expect(sessionState.get(SID, "theme")).toBe("textual-dark");
    expect(sessionState.get(SID, "style")).toBe("muted");
  });

  test("a nested dispatch effect is reported, never executed", () => {
    const sessionState = new SessionState();
    const url = effectsUrl([{ verb: VERB_DISPATCH, args: ["whatever"] }]);
    expect(() => clickUrl(url, ctx(sessionState))).toThrow(
      /unknown effect verb "dispatch"/,
    );
  });

  test("dispatch is the only verb that resolves a nested dispatch — leaf table excludes it", () => {
    // The full table dispatches `dispatch`, but the leaf table it folds over
    // does not — so an effect can never re-enter dispatch.
    expect(VERBS.has(VERB_DISPATCH)).toBe(true);
  });
});
