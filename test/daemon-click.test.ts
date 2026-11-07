import fs from "node:fs";
import path from "node:path";
import { PROTOCOL_VERSION, encodeFrame } from "../src/daemon/protocol";
import { socketPath } from "../src/daemon/paths";
import { SessionState, SINGLE_RUN } from "../src/daemon/session-state";
import { JournalTurns } from "../src/daemon/journal-turns";
import { systemTimekeeper } from "../src/time";
import { BadVerbArgs, LEAF_VERB_NAMES, readClick } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import { MAIN_NAME } from "../src/daemon/home";
import {
  addressedLink,
  encodeSegments,
  VERB_DISPATCH,
  VERB_STEP_STATE,
  VERB_TOOLBAR_TOGGLE,
  VERB_APPLY_UPDATE,
} from "../src/click/wire";
import { applyClick, clickUrl, recordRender, runLink, testVerbContext, clicking, effectLink } from "./helpers/click";
import { lastClickError } from "../src/daemon/click-error";
import { EMPTY_DEFAULT } from "./helpers/parse-and-validate";
import type { DslConfig } from "../src/config/dsl-types";

// --- SessionState unit tests ---

describe("SessionState", () => {
  test("get returns null for unknown session/key", () => {
    const state = new SessionState(SINGLE_RUN);
    expect(state.get("abc-123", "theme")).toBeNull();
  });

  test("set/get round-trips a value", () => {
    const state = new SessionState(SINGLE_RUN);
    state.set("abc-123", "theme", "ocean");
    expect(state.get("abc-123", "theme")).toBe("ocean");
  });

  test("different sessions are independent", () => {
    const state = new SessionState(SINGLE_RUN);
    state.set("session-a", "theme", "ocean");
    state.set("session-b", "theme", "ember");
    expect(state.get("session-a", "theme")).toBe("ocean");
    expect(state.get("session-b", "theme")).toBe("ember");
  });

  test("clear removes a key", () => {
    const state = new SessionState(SINGLE_RUN);
    state.set("abc-123", "theme", "ocean");
    state.clear("abc-123", "theme");
    expect(state.get("abc-123", "theme")).toBeNull();
  });

  test("multiple keys per session are independent", () => {
    const state = new SessionState(SINGLE_RUN);
    state.set("abc-123", "theme", "ocean");
    state.set("abc-123", "style", "surface");
    expect(state.get("abc-123", "theme")).toBe("ocean");
    expect(state.get("abc-123", "style")).toBe("surface");
  });

  test("toolbar-expanded key works for toggle semantics", () => {
    const state = new SessionState(SINGLE_RUN);
    expect(state.get("s1", "toolbar-expanded")).toBeNull();
    state.set("s1", "toolbar-expanded", "1");
    expect(state.get("s1", "toolbar-expanded")).toBe("1");
    state.clear("s1", "toolbar-expanded");
    expect(state.get("s1", "toolbar-expanded")).toBeNull();
  });
});

// --- Protocol-level click tests ---
// These test the daemon handles click requests over the wire. We spin up a
// minimal daemon echo server that mimics the daemon's click dispatch.

describe("click protocol", () => {
  test("ClickRequest serializes with correct kind", () => {
    const req = {
      v: PROTOCOL_VERSION,
      kind: "click" as const,
      url: "cc-candybar://toolbar-toggle/test-session",
    };
    const encoded = encodeFrame(req);
    const len = encoded.readUInt32BE(0);
    const body = JSON.parse(encoded.subarray(4, 4 + len).toString("utf8"));
    expect(body.kind).toBe("click");
    expect(body.url).toBe("cc-candybar://toolbar-toggle/test-session");
  });

  test("the click read is prototype-pollution-safe", () => {
    // [LAW:types-are-the-program] The click readers are a ReadonlyMap, not a
    // plain object — wire-level untrusted verb names like `__proto__` and
    // `constructor` are non-members, not truthy hits on Object.prototype.
    // A future revert to `Readonly<Record<string, VerbHandler>>` would
    // let those names return prototype functions, bypass the `!handler`
    // check in handleClick, then crash on `handler(value, ctx)` as
    // RENDER_FAILED instead of the intended BAD_REQUEST.
    // [LAW:behavior-not-structure] Pins the safety guarantee at lookup,
    // so the regression reads as "verb table leaks Object.prototype"
    // rather than as a type-only diff a reviewer might wave through.
    for (const poison of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(readClick(poison, "")).toBeNull();
    }
  });

  test("a link naming a leaf verb itself is no click: a leaf arrives only as a dispatch's effect", () => {
    for (const verb of LEAF_VERB_NAMES) {
      expect(readClick(verb, encodeSegments(["s1"]))).toBeNull();
    }
  });

  test("malformed wire encoding is a BadVerbArgs (→ BAD_REQUEST), not an operational failure", async () => {
    // [LAW:behavior-not-structure] A bad percent-escape on the wire is an
    // argument-shape failure; the dispatcher routes BadVerbArgs to BAD_REQUEST
    // and any other Error to RENDER_FAILED. A lone `%` makes decodeURIComponent
    // throw a raw URIError — without reclassification it would surface as an
    // operational RENDER_FAILED. Pins the single-arg (toolbar-toggle) and multi-seg
    // (set-state) codecs at their shared decode boundary. The effect is spelled
    // by hand: the wire's own encoder never writes a lone `%`.
    const ctx: VerbContext = testVerbContext(new SessionState(SINGLE_RUN));
    for (const verb of [VERB_TOOLBAR_TOGGLE, "set-state"]) {
      const url = addressedLink(
        MAIN_NAME,
        VERB_DISPATCH,
        `e=${encodeURIComponent(`${verb}/%`)}`,
      );
      expect(() => runLink(url, ctx)).toThrow(BadVerbArgs);
    }
  });
});

describe("apply-update verb", () => {
  // [LAW:effects-at-boundaries] The wire carries only the session id; the
  // handler's whole job is describing the act, which the performer reaches
  // through ctx once the click has answered.
  const url = (sid: string) =>
    effectLink(VERB_APPLY_UPDATE, sid);

  test("a session id reaches ctx.applyUpdate once, outside the turn and unawaited by the click; a missing or unsafe one is BadVerbArgs and never does", async () => {
    const holders: Array<string | null> = [];
    let release = (): void => {};
    const acting = new Promise<void>((resolve) => (release = resolve));
    // The test holds the turns itself: a verb's view of them cannot say
    // whether a turn is held (src/daemon/verbs/index.ts), which this test reads.
    const turns = new JournalTurns();
    const ctx: VerbContext = {
      ...testVerbContext(new SessionState(SINGLE_RUN), undefined, undefined, undefined, turns),
      applyUpdate: () => {
        holders.push(turns.inTurn());
        return acting;
      },
    };
    // The click answers while the act is still running, and the act ran in
    // no turn.
    const { performed } = await applyClick(url("sess-1"), ctx);
    expect(holders).toEqual([null]);
    release();
    await performed;
    await expect(applyClick(url(""), ctx)).rejects.toThrow(BadVerbArgs);
    await expect(applyClick(url("../etc"), ctx)).rejects.toThrow(BadVerbArgs);
    expect(holders).toEqual([null]);
  });

  test("an act refused is the effect's failure: held for the session's bar, with the act's own words", async () => {
    const sessionState = new SessionState(SINGLE_RUN);
    const ctx: VerbContext = {
      ...testVerbContext(sessionState),
      applyUpdate: async () => {
        throw new BadVerbArgs("apply-update: already rebuilding…");
      },
    };
    await clickUrl(url("sess-1"), ctx);
    expect(lastClickError(sessionState, "sess-1")?.text).toBe(
      "apply-update: already rebuilding…",
    );
  });
});

// --- Test that statusline binary has no in-process render path ---

describe("statusline binary render isolation", () => {
  test("index.ts does not import PowerlineRenderer", () => {
    const indexSrc = fs.readFileSync(
      path.join(__dirname, "../src/index.ts"),
      "utf8",
    );
    expect(indexSrc).not.toContain("PowerlineRenderer");
    expect(indexSrc).not.toContain("GitService");
    expect(indexSrc).not.toContain("loadConfigFromCLI");
  });

  test("index.ts has no inline render path", () => {
    const indexSrc = fs.readFileSync(
      path.join(__dirname, "../src/index.ts"),
      "utf8",
    );
    // The only render attempt is via tryRenderViaDaemon.
    expect(indexSrc).toContain("tryRenderViaDaemon");
    // No fallback to in-process rendering.
    expect(indexSrc).not.toContain("generateStatusline");
    expect(indexSrc).not.toContain("new PowerlineRenderer");
  });
});

// --- Toolbar toggle dataflow ---
// Verify the dataflow: toolbar-toggle click updates daemon state, next render
// sees the change without re-reading from disk.

describe("toolbar toggle dataflow", () => {
  test("toggle via SessionState reflects in get without disk I/O", () => {
    // [LAW:one-source-of-truth] The SessionState is the daemon's in-memory
    // source of truth. No file reads needed.
    const state = new SessionState(SINGLE_RUN);
    const sessionId = "toggle-test-session";

    // Initially not expanded.
    expect(state.get(sessionId, "toolbar-expanded")).toBeNull();

    // Set → expanded.
    state.set(sessionId, "toolbar-expanded", "1");
    expect(state.get(sessionId, "toolbar-expanded")).toBe("1");

    // Clear → collapsed.
    state.clear(sessionId, "toolbar-expanded");
    expect(state.get(sessionId, "toolbar-expanded")).toBeNull();
  });
});

// --- step-state handler (relative nudge) ---
// [LAW:behavior-not-structure] The handler IS the bug fix: it reads LIVE state
// per click and re-computes the absolute target, so the value moves once per
// CLICK regardless of render cadence (the prior absolute-target write moved once
// per RENDER). These exercise the real handler at the daemon boundary, against a
// real SessionState and the gate of the config the session renders.

describe("step-state handler", () => {
  const KEY = "step-test-hue";
  // A config whose stepper bounds KEY to [min,max]: the session's config holds
  // both the bounds (its action) and what an unset key steps from (its `state`
  // variable's default).
  const stepper = (dflt: string, min = 0, max = 60): DslConfig => ({
    ...EMPTY_DEFAULT,
    variables: { hue: { kind: "state", key: KEY, default: dflt } },
    actions: { nudge: { set: KEY, min, max, by: 2 } },
  });
  // A session rendering `config`, and its step click.
  function session(config: DslConfig) {
    const sessionState = new SessionState(SINGLE_RUN);
    recordRender(sessionState, "s1");
    const ctx: VerbContext = testVerbContext(sessionState, undefined, config);
    const step = clicking(VERB_STEP_STATE);
    const click = async (by: number): Promise<void> => {
      await step(encodeSegments(["s1", KEY, String(by)]), ctx);
    };
    return { sessionState, ctx, click };
  }
  const setup = () => session(stepper("14"));

  test("an unset key steps from its config's default, not min", async () => {
    const { sessionState, click } = setup();
    expect(sessionState.get("s1", KEY)).toBeNull();
    await click(2);
    expect(sessionState.get("s1", KEY)).toBe("16"); // 14 + 2, NOT 0 + 2
  });

  test("N identical clicks accumulate N steps (idempotency gone)", async () => {
    const { sessionState, click } = setup();
    await click(2);
    await click(2);
    await click(2);
    expect(sessionState.get("s1", KEY)).toBe("20"); // 14 → 16 → 18 → 20
  });

  test("stepping past a bound WRAPS to the other end", async () => {
    const { sessionState, click } = setup();
    sessionState.set("s1", KEY, "60"); // max
    await click(2);
    expect(sessionState.get("s1", KEY)).toBe("0"); // wrapped, not clamped to 60
  });

  test("a negative delta steps down", async () => {
    const { sessionState, click } = setup();
    sessionState.set("s1", KEY, "10");
    await click(-2);
    expect(sessionState.get("s1", KEY)).toBe("8");
  });

  test("a non-integer delta is BadVerbArgs (→ BAD_REQUEST)", async () => {
    const { ctx } = setup();
    const step = clicking(VERB_STEP_STATE);
    expect(() => step(encodeSegments(["s1", KEY, "x"]), ctx),
    ).toThrow(BadVerbArgs);
  });

  // Two configs declaring the same stepper differently are two gates: each
  // session steps from, and wraps at, what ITS config declares
  // (brandon-state-gates-lbs — the bounds were once every loaded config's,
  // merged to the widest).
  test("an unset key steps from the default of the config ITS session renders with", async () => {
    const stepIn = async (dflt: string): Promise<string | null> => {
      const { sessionState, click } = session(stepper(dflt));
      await click(2);
      return sessionState.get("s1", KEY);
    };
    expect(await stepIn("14")).toBe("16");
    expect(await stepIn("30")).toBe("32");
  });

  test("a step wraps at the bounds of the config ITS session renders with", async () => {
    const narrow = session(stepper("2", 0, 2));
    const wide = session(stepper("2", 0, 8));
    for (const s of [narrow, wide]) s.sessionState.set("s1", KEY, "2");
    await wide.click(2);
    await narrow.click(2);
    // From its own max, the narrow session wraps to its min; the wide one,
    // whose config declares room above 2, steps on.
    expect(narrow.sessionState.get("s1", KEY)).toBe("0");
    expect(wide.sessionState.get("s1", KEY)).toBe("4");
  });

  test("one key a word list in one config and a range in another gates each session by its own", async () => {
    const words = session({
      ...EMPTY_DEFAULT,
      actions: { pick: { set: KEY, from: ["warm", "cool"] } },
    });
    const range = session(stepper("14"));
    const set = clicking("set-state");
    await set(encodeSegments(["s1", KEY, "cool"]), words.ctx);
    expect(words.sessionState.get("s1", KEY)).toBe("cool");
    await range.click(2);
    expect(range.sessionState.get("s1", KEY)).toBe("16");
    // Each refuses what only the other's config declares.
    await expect(words.click(2)).rejects.toThrow(/not a bounded \(range\) state key/);
    expect(() => set(encodeSegments(["s1", KEY, "cool"]), range.ctx),
    ).toThrow(/must be an integer, got "cool"/);
  });

  test("an unset key whose config shows a non-integer is refused, not stepped from min", async () => {
    const { sessionState, click } = session(stepper("wide"));
    await expect(click(2)).rejects.toThrow(
      /"step-test-hue" shows "wide" before any click/,
    );
    expect(sessionState.get("s1", KEY)).toBeNull();
  });

  test("a key the session's config declares no range for is rejected, not silently stepped", async () => {
    const step = clicking(VERB_STEP_STATE);
    const { ctx } = setup();
    expect(() => step(encodeSegments(["s1", "not-a-stepper", "2"]), ctx),
    ).toThrow(BadVerbArgs);
  });

  test("step-state is a registered leaf verb", () => {
    expect(LEAF_VERB_NAMES).toContain(VERB_STEP_STATE);
  });
});
