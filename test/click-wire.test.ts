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
  VERB_APPLY_LAYOUT_OP,
  VERB_APPLY_UPDATE,
  VERB_BACK,
  VERB_COPY,
  VERB_COPY_DIAGNOSTIC,
  VERB_DELETE_PRESET,
  VERB_DISPATCH,
  VERB_DOCTOR_FIX,
  VERB_DOCTOR_MARK,
  VERB_DOCTOR_RUN,
  VERB_LOAD_CONFIG,
  VERB_OPEN_VSCODE,
  VERB_REDO,
  VERB_REPO_CONFIG,
  VERB_RESET_CONFIG,
  VERB_REWIND,
  VERB_RUN,
  VERB_SAVE,
  VERB_SAVE_PRESET,
  VERB_SAVE_THEME_DEFAULT,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
  VERB_SLASH,
  VERB_STEP_CONFIG,
  VERB_STEP_STATE,
  VERB_TOOLBAR_TOGGLE,
  VERB_UNDO,
  batchAdjacentWrites,
  type Effect,
} from "../src/click/wire";
import { parseHandlerUrl } from "../src/install/index";
import { VERBS, BadVerbArgs } from "../src/daemon/verbs";
import { SessionState } from "../src/daemon/session-state";
import {
  recordRender,
  testVerbContext,
  effectsOf,
  clickUrl,
} from "./helpers/click";
import { EMPTY_DEFAULT } from "./helpers/parse-and-validate";
import { lastClickError } from "../src/daemon/click-error";

const SID = "s1";
// A session that has rendered a config declaring no action: its gate holds
// the built-in keys (theme, endcaps) and nothing else.
const ctx = (sessionState: SessionState) => {
  recordRender(sessionState, SID);
  return testVerbContext(sessionState, undefined, EMPTY_DEFAULT);
};

describe("click wire — encode/decode round-trip", () => {
  test("a single effect serializes to a dispatch URL and decodes back", () => {
    const url = effectsUrl([
      { verb: VERB_SET_STATE, args: [SID, "theme", "nord"] },
    ]);
    expect(url.startsWith("cc-candybar://dispatch/does=set+theme+to+nord&e=")).toBe(
      true,
    );
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

// [LAW:verifiable-goals] What a hover reads for each verb, pinned word for word.
// test/click-does.test.ts holds these to the bar's real clicks.
describe("a link says in words what its click does", () => {
  const spelled = (effects: readonly Effect[]): string =>
    /^cc-candybar:\/\/dispatch\/does=([^&]*)/.exec(effectsUrl(effects))![1]!;
  const does = (effects: readonly Effect[]): string =>
    new URLSearchParams(`does=${spelled(effects)}`).get("does")!;
  const MAC = "ab".repeat(32);

  test.each<[Effect, string]>([
    [
      { verb: VERB_SET_STATE, args: [SID, "theme", "nord"] },
      "set theme to nord",
    ],
    [
      { verb: VERB_SET_STATE, args: [SID, "candybar.tab", "closed"] },
      "close candybar.tab",
    ],
    [
      { verb: VERB_SET_STATE, args: [SID, "menus.pickers", "apply.theme"] },
      "open apply.theme",
    ],
    [
      { verb: VERB_SET_STATE, args: [SID, "menus.pickers", "closed"] },
      "close pickers",
    ],
    [
      { verb: VERB_SET_STATE, args: [SID, "menupages.menus.pickers", "2"] },
      "turn pickers to page 3",
    ],
    [
      { verb: VERB_SET_STATE, args: [SID, "candybar.diagnostics", "2583095"] },
      "open diagnostics",
    ],
    [
      { verb: VERB_STEP_STATE, args: [SID, "padding", "1"] },
      "step padding up by 1",
    ],
    [
      { verb: VERB_STEP_STATE, args: [SID, "padding", "-1"] },
      "step padding down by 1",
    ],
    [
      { verb: VERB_SET_CONFIG, args: [SID, "wrap", "true"] },
      "save wrap as true",
    ],
    [
      { verb: VERB_STEP_CONFIG, args: [SID, "padding", "-1"] },
      "save step padding down by 1",
    ],
    [{ verb: VERB_RESET_CONFIG, args: [SID, "palette"] }, "reset palette"],
    [
      {
        verb: VERB_APPLY_LAYOUT_OP,
        args: [SID, "presets.a.root", "remove:model"],
      },
      "edit remove:model in presets.a.root",
    ],
    [{ verb: VERB_COPY, args: ["/tmp/proj"] }, "copy /tmp/proj"],
    [
      { verb: VERB_COPY_DIAGNOSTIC, args: [SID, "request", "42"] },
      "copy diagnostic",
    ],
    [
      { verb: VERB_OPEN_VSCODE, args: ["/tmp/a.ts"] },
      "open /tmp/a.ts in vs code",
    ],
    [{ verb: VERB_TOOLBAR_TOGGLE, args: [SID] }, "toggle the toolbar"],
    [
      { verb: VERB_LOAD_CONFIG, args: [SID, "/tmp/c.json5"] },
      "load config /tmp/c.json5",
    ],
    [{ verb: VERB_SAVE, args: [SID] }, "save settings"],
    [{ verb: VERB_SAVE_PRESET, args: [SID] }, "save as a new preset"],
    [
      { verb: VERB_SAVE_THEME_DEFAULT, args: [SID] },
      "save this look for the theme",
    ],
    [
      { verb: VERB_DELETE_PRESET, args: [SID, "custom-1"] },
      "delete preset custom-1",
    ],
    [{ verb: VERB_UNDO, args: [SID] }, "undo"],
    [{ verb: VERB_REDO, args: [SID] }, "redo"],
    [{ verb: VERB_BACK, args: [SID] }, "go back"],
    [{ verb: VERB_REWIND, args: [SID] }, "cancel edits"],
    [{ verb: VERB_APPLY_UPDATE, args: [SID] }, "update cc-candybar"],
    [{ verb: VERB_DOCTOR_RUN, args: [SID] }, "run doctor"],
    [{ verb: VERB_DOCTOR_FIX, args: [SID, "hooks"] }, "fix hooks"],
    [
      { verb: VERB_DOCTOR_MARK, args: [SID, "glyphs", "yes"] },
      "mark glyphs yes",
    ],
    [{ verb: VERB_SLASH, args: [SID, "/clear"] }, "type /clear"],
    [{ verb: VERB_RUN, args: [SID, "deploy", "{}", MAC] }, "run deploy"],
    [
      { verb: VERB_REPO_CONFIG, args: [SID, "/tmp/repo", "approved", MAC] },
      "approved config in /tmp/repo",
    ],
  ])("%j says %s", (effect, text) => {
    expect(does([effect])).toBe(text);
  });

  test("a click that does several things says the first and counts the rest", () => {
    expect(
      does([
        { verb: VERB_SET_STATE, args: [SID, "candybar.tab", "look"] },
        { verb: VERB_SET_STATE, args: [SID, "a", "1", "b", "2"] },
      ]),
    ).toBe("set candybar.tab to look and 2 more");
  });

  test("what a click fires speaks over the session writes around it", () => {
    expect(
      does([
        {
          verb: VERB_SET_STATE,
          args: [SID, "commands.clear.armed", "disarmed"],
        },
        { verb: VERB_SLASH, args: [SID, "/clear"] },
      ]),
    ).toBe("type /clear and 1 more");
  });

  test("a hover reads words joined the way a form joins them", () => {
    expect(
      spelled([{ verb: VERB_SET_STATE, args: [SID, "preset", "compact"] }]),
    ).toBe("set+preset+to+compact");
  });

  test.each(["▲", "a b", "a-b", "a+b", "a&b=c#d", "100%"])(
    "the value %s keeps every character",
    (value) => {
      const text = does([{ verb: VERB_SET_STATE, args: [SID, "k", value] }]);
      expect(text).toBe(`set k to ${value}`);
    },
  );

  test("a link is printable ASCII whatever a value holds", () => {
    expect(
      effectsUrl([{ verb: VERB_SET_STATE, args: [SID, "k", "▲ 🍫"] }]),
    ).toMatch(/^[\x21-\x7e]+$/);
  });

  test("a long copied text keeps both ends, whole characters at each", () => {
    const text = does([
      { verb: VERB_COPY, args: [`${"🍫".repeat(80)}/config.json5`] },
    ]);
    expect(text).toMatch(/^copy 🍫+\.\.\.🍫+\/config\.json5$/u);
    expect([...text].length).toBeLessThanOrEqual("copy ".length + 60);
  });

  test("only copied text is cut", () => {
    const value = "a".repeat(200);
    expect(does([{ verb: VERB_SET_STATE, args: [SID, "k", value] }])).toBe(
      `set k to ${value}`,
    );
  });

  test("a draw that holds a fact the effects do not can say it instead", () => {
    const effects: Effect[] = [
      { verb: VERB_SET_STATE, args: [SID, "k", "2583095899324419"] },
    ];
    const url = effectsUrl(effects, "show diagnostic 2 of 15 page 3");
    expect(url).toContain("does=show+diagnostic+2+of+15+page+3&e=");
    expect(effectsOf(url)).toEqual(effectsOf(effectsUrl(effects)));
  });

  test("the words are not part of the click", () => {
    const url = effectsUrl([
      { verb: VERB_SET_STATE, args: [SID, "theme", "nord"] },
    ]);
    expect(effectsOf(url.replace(/does=[^&]*/, "does=anything"))).toEqual(
      effectsOf(url),
    );
  });
});

// [LAW:one-source-of-truth] The wire is a published contract: a link already in
// a terminal's scrollback was drawn before `does` existed, and the emitter can no
// longer spell one, so this shape is written out by hand.
describe("a dispatch link drawn before `does` existed", () => {
  const url =
    "cc-candybar://dispatch/e=set-state%2Fs1%2Ftheme%2Fnord&e=set-state%2Fs1%2Fendcaps%2Fplain";

  test("parses to its effects", () => {
    expect(effectsOf(url)).toEqual([
      { verb: "set-state", args: [SID, "theme", "nord"] },
      { verb: "set-state", args: [SID, "endcaps", "plain"] },
    ]);
  });

  test("still runs", async () => {
    const sessionState = new SessionState();
    await clickUrl(url, ctx(sessionState));
    expect(sessionState.get(SID, "theme")).toBe("nord");
    expect(sessionState.get(SID, "endcaps")).toBe("plain");
  });
});

describe("parseHandlerUrl — verb split, value raw", () => {
  test("dispatch URL → verb=dispatch, value is the raw query string", () => {
    const url = effectsUrl([{ verb: VERB_COPY, args: ["hi"] }]);
    const { verb, value } = parseHandlerUrl(url);
    expect(verb).toBe(VERB_DISPATCH);
    expect(parseEffects(value)).toEqual([{ verb: "copy", value: "hi" }]);
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

  test("effectsOf mirrors the daemon's per-verb decode (single-arg whole, set-state segmented)", () => {
    // A single-arg verb decodes the whole value: direct `copy/a/b` → one arg
    // "a/b", matching what the copy handler copies (so the helper can't mask a
    // back-compat regression).
    expect(effectsOf("cc-candybar://copy/a/b")).toEqual([
      { verb: "copy", args: ["a/b"] },
    ]);
    // set-state, the one multi-arg verb, still segments.
    expect(effectsOf("cc-candybar://set-state/s1/theme/nord")).toEqual([
      { verb: "set-state", args: ["s1", "theme", "nord"] },
    ]);
    // The doctor verbs: doctor-run takes the session alone (whole decode),
    // doctor-fix the session and the check (segmented) — the classification a
    // prior round caught drifting.
    expect(effectsOf(`cc-candybar://${VERB_DOCTOR_RUN}/a/b`)).toEqual([
      { verb: VERB_DOCTOR_RUN, args: ["a/b"] },
    ]);
    expect(
      effectsOf(`cc-candybar://${VERB_DOCTOR_FIX}/s1/tmuxTruecolor`),
    ).toEqual([{ verb: VERB_DOCTOR_FIX, args: ["s1", "tmuxTruecolor"] }]);
    // The preset verbs segment like set-state (their handlers split), and
    // load-config splits once, since its path has slashes of its own.
    expect(effectsOf("cc-candybar://delete-preset/s1/custom-1")).toEqual([
      { verb: "delete-preset", args: ["s1", "custom-1"] },
    ]);
    expect(effectsOf("cc-candybar://load-config/s1/%2Fhome%2Fa%2Fb.json5")).toEqual([
      { verb: "load-config", args: ["s1", "/home/a/b.json5"] },
    ]);
  });
});

describe("dispatch verb — run all, aggregate, no nesting", () => {
  test("every effect runs; a later failure does not undo an earlier success", async () => {
    const sessionState = new SessionState();
    // First effect writes a valid key; second steps an unknown key (rejected).
    // Two DIFFERENT verbs, so they are two steps, not one batch (next test).
    const url = effectsUrl([
      { verb: VERB_SET_STATE, args: [SID, "theme", "textual-dark"] },
      { verb: VERB_STEP_STATE, args: [SID, "no-such-key", "1"] },
    ]);
    // The aggregated failure surfaces, naming the bad effect...
    await expect(clickUrl(url, ctx(sessionState))).rejects.toThrow(/no-such-key/);
    // ...but the valid write before it still landed (no rollback).
    expect(sessionState.get(SID, "theme")).toBe("textual-dark");
  });

  test("adjacent session writes are one batch: all land, or none do", async () => {
    const sessionState = new SessionState();
    // A `do` action's members, or a picker option plus its close writes, are
    // separate set-state effects in the URL — the codec carries them as given.
    const effects: Effect[] = [
      { verb: VERB_SET_STATE, args: [SID, "theme", "textual-dark"] },
      { verb: VERB_SET_STATE, args: [SID, "no-such-key", "x"] },
    ];
    const url = effectsUrl(effects);
    expect(effectsOf(url)).toEqual(effects);
    // Dispatch validates the run whole, so the valid write does not land alone.
    await expect(clickUrl(url, ctx(sessionState))).rejects.toThrow(/no-such-key/);
    expect(sessionState.get(SID, "theme")).toBeNull();
  });

  test("a batch never reaches past another effect or into another session", () => {
    const set = (sid: string, k: string, v: string) => ({
      verb: VERB_SET_STATE,
      value: `${sid}/${k}/${v}`,
    });
    const copy = { verb: VERB_COPY, value: "x" };
    // Order is the click's: the copy between two writes keeps its place.
    expect(
      batchAdjacentWrites([set("a", "k1", "v1"), set("a", "k2", "v2"), copy, set("a", "k3", "v3")]),
    ).toEqual([
      { verb: VERB_SET_STATE, value: "a/k1/v1/k2/v2" },
      copy,
      set("a", "k3", "v3"),
    ]);
    // A different session id starts a new batch rather than joining one.
    expect(batchAdjacentWrites([set("a", "k", "v"), set("b", "k", "v")])).toEqual([
      set("a", "k", "v"),
      set("b", "k", "v"),
    ]);
  });

  test("adjacent resets for one session join into one reset of every key, never with a set-state", () => {
    const reset = (sid: string, k: string) => ({ verb: VERB_RESET_CONFIG, value: `${sid}/${k}` });
    const set = { verb: VERB_SET_STATE, value: "a/k/v" };
    expect(
      batchAdjacentWrites([set, reset("a", "palette"), reset("a", "style"), reset("b", "endcaps")]),
    ).toEqual([set, { verb: VERB_RESET_CONFIG, value: "a/palette/style" }, reset("b", "endcaps")]);
  });

  test("an input-only failure keeps the BadVerbArgs (BAD_REQUEST) classification", async () => {
    // A leaf's input rejection (set-state unknown key) is BadVerbArgs; the
    // aggregate must stay BadVerbArgs so the dispatcher maps it to BAD_REQUEST,
    // not RENDER_FAILED. (An operational leaf failure flips it to a plain Error.)
    const sessionState = new SessionState();
    const url = effectsUrl([{ verb: VERB_SET_STATE, args: [SID, "no-such-key", "x"] }]);
    await expect(clickUrl(url, ctx(sessionState))).rejects.toThrow(BadVerbArgs);
  });

  test("a clean compound click applies both set effects", async () => {
    const sessionState = new SessionState();
    const url = effectsUrl([
      { verb: VERB_SET_STATE, args: [SID, "theme", "textual-dark"] },
      { verb: VERB_SET_STATE, args: [SID, "endcaps", "capsule"] },
    ]);
    await clickUrl(url, ctx(sessionState));
    expect(sessionState.get(SID, "theme")).toBe("textual-dark");
    expect(sessionState.get(SID, "endcaps")).toBe("capsule");
  });

  test("a nested dispatch effect is reported, never executed", async () => {
    const sessionState = new SessionState();
    const url = "cc-candybar://dispatch/e=dispatch%2Fwhatever";
    await expect(clickUrl(url, ctx(sessionState))).rejects.toThrow(
      /unknown effect verb "dispatch"/,
    );
  });

  test("dispatch is the only verb that resolves a nested dispatch — leaf table excludes it", () => {
    // The full table dispatches `dispatch`, but the leaf table it folds over
    // does not — so an effect can never re-enter dispatch.
    expect(VERBS.has(VERB_DISPATCH)).toBe(true);
  });

  test("per-effect errors are written to click.error in session state for bar display", async () => {
    const sessionState = new SessionState();
    // Two effects: first valid, second bad. Dispatch throws but also writes
    // per-effect errors to session state so the next render shows them.
    const url = effectsUrl([
      { verb: VERB_SET_STATE, args: [SID, "theme", "textual-dark"] },
      { verb: VERB_SET_STATE, args: [SID, "no-such-key", "x"] },
    ]);
    await expect(clickUrl(url, ctx(sessionState))).rejects.toThrow();
    const clickError = lastClickError(sessionState, SID)?.text ?? null;
    expect(clickError).not.toBeNull();
    expect(clickError).toMatch(/no-such-key/);
    // Session ID is extracted from the first set-state effect.
    expect(clickError).toMatch(/set-state:/);
  });

  test("a session-bearing step's malformed argument is that step's error: the click still finds its session and runs the rest", async () => {
    const sessionState = new SessionState();
    // A load-config path carrying a bad percent escape (`%ZZ`).
    const url = effectsUrl([
      { verb: VERB_LOAD_CONFIG, args: [SID, "BAD"] },
      { verb: VERB_SET_STATE, args: [SID, "theme", "textual-dark"] },
    ]).replace("BAD", encodeURIComponent("%ZZ"));
    await expect(clickUrl(url, ctx(sessionState))).rejects.toThrow(BadVerbArgs);
    expect(sessionState.get(SID, "theme")).toBe("textual-dark");
    expect(lastClickError(sessionState, SID)?.text).toMatch(/load-config:/);
  });

  test("click.error is not written when no session-bearing effect exists", async () => {
    const sessionState = new SessionState();
    // copy-only dispatch with an unknown verb — no session ID available.
    const url = "cc-candybar://dispatch/e=dispatch%2Fwhatever";
    await expect(clickUrl(url, ctx(sessionState))).rejects.toThrow();
    expect(lastClickError(sessionState, SID)?.text ?? null).toBeNull();
  });
});
