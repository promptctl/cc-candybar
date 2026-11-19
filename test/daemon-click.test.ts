import fs from "node:fs";
import path from "node:path";
import { SessionState } from "../src/renderer/session-state";
import { BadVerbArgs } from "../src/renderer/verbs";
import type { VerbContext } from "../src/renderer/verbs";
import {
  VERB_NAMES,
  admitClick,
  encodeSegments,
  VERB_STEP_STATE,
} from "../src/click/wire";
import {
  clickUrl,
  recordRender,
  testVerbContext,
  verbContextWith,
  CLICK_VERBS,
} from "./helpers/click";
import { EMPTY_DEFAULT } from "./helpers/parse-and-validate";
import type { DslConfig } from "../src/config/dsl-types";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { TEST_SIGNER } from "./helpers/link-signer";

const ABC_123 = sessionIdOf("abc-123");
const SESSION_A = sessionIdOf("session-a");
const SESSION_B = sessionIdOf("session-b");
const A_2 = sessionIdOf("a");
const B = sessionIdOf("b");
const C = sessionIdOf("c");
const S1 = sessionIdOf("s1");

// --- SessionState unit tests ---

describe("SessionState", () => {
  test("get returns null for unknown session/key", () => {
    const state = new SessionState();
    expect(state.get(ABC_123, "theme")).toBeNull();
  });

  test("set/get round-trips a value", () => {
    const state = new SessionState();
    state.set(ABC_123, "theme", "ocean");
    expect(state.get(ABC_123, "theme")).toBe("ocean");
  });

  test("different sessions are independent", () => {
    const state = new SessionState();
    state.set(SESSION_A, "theme", "ocean");
    state.set(SESSION_B, "theme", "ember");
    expect(state.get(SESSION_A, "theme")).toBe("ocean");
    expect(state.get(SESSION_B, "theme")).toBe("ember");
  });

  test("clear removes a key", () => {
    const state = new SessionState();
    state.set(ABC_123, "theme", "ocean");
    state.clear(ABC_123, "theme");
    expect(state.get(ABC_123, "theme")).toBeNull();
  });

  test("multiple keys per session are independent", () => {
    const state = new SessionState();
    state.set(ABC_123, "theme", "ocean");
    state.set(ABC_123, "style", "surface");
    expect(state.get(ABC_123, "theme")).toBe("ocean");
    expect(state.get(ABC_123, "style")).toBe("surface");
  });

  // The host's copy hears each session that moved, as it now stands, in the
  // order they last moved, and hears it once.
  test("drain tells each session that moved, in the order it last moved", () => {
    const state = new SessionState();
    state.set(A_2, "theme", "ocean");
    state.set(B, "theme", "ember");
    state.set(C, "theme", "forest");
    state.clear(B, "theme");
    state.set(A_2, "style", "surface");
    expect(state.drain()).toEqual([
      { store: "session-state", key: C, value: { theme: "forest" } },
      { store: "session-state", key: B, value: null },
      {
        store: "session-state",
        key: A_2,
        value: { theme: "ocean", style: "surface" },
      },
    ]);
    expect(state.drain()).toEqual([]);
  });
});

describe("click protocol", () => {
  test("a link from the retired upgrade notice is refused without an effect", async () => {
    const ctx = testVerbContext(new SessionState());
    await expect(
      clickUrl("cc-candybar://dispatch/e=apply-update%2Fs1", ctx),
    ).rejects.toThrow(/apply-update/);
    expect(ctx.effects).toEqual([]);
  });

  test("VERB_NAMES lookup is prototype-pollution-safe", () => {
    // External verb names are admitted only from the link vocabulary.
    for (const poison of [
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
    ]) {
      expect(() => admitClick(poison, "a", TEST_SIGNER)).toThrow(BadVerbArgs);
    }
  });

  test("malformed wire encoding is a BadVerbArgs (→ BAD_REQUEST), not an operational failure", async () => {
    // [LAW:behavior-not-structure] A bad percent-escape on the wire is an
    // argument-shape failure; the dispatcher routes BadVerbArgs to BAD_REQUEST
    // and any other Error to RENDER_FAILED. A lone `%` makes decodeURIComponent
    // throw a raw URIError — without reclassification it would surface as an
    // operational RENDER_FAILED. Pins the single-arg (copy) and multi-seg
    // (set-state) codecs at their shared decode boundary.
    const ctx: VerbContext = testVerbContext(new SessionState());
    for (const verb of ["copy", "set-state"]) {
      const handler = CLICK_VERBS.get(verb)!;
      expect(() => handler("%", ctx)).toThrow(BadVerbArgs);
    }
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
    const sessionState = new SessionState();
    recordRender(sessionState, S1);
    const ctx: VerbContext = testVerbContext(sessionState, undefined, config);
    const step = CLICK_VERBS.get(VERB_STEP_STATE)!;
    const click = async (by: number): Promise<void> =>
      await step(encodeSegments(["s1", KEY, String(by)]), ctx);
    return { sessionState, ctx, click };
  }
  const setup = () => session(stepper("14"));

  test("an unset key steps from its config's default, not min", async () => {
    const { sessionState, click } = setup();
    expect(sessionState.get(S1, KEY)).toBeNull();
    await click(2);
    expect(sessionState.get(S1, KEY)).toBe("16"); // 14 + 2, NOT 0 + 2
  });

  test("N identical clicks accumulate N steps (idempotency gone)", async () => {
    const { sessionState, click } = setup();
    await click(2);
    await click(2);
    await click(2);
    expect(sessionState.get(S1, KEY)).toBe("20"); // 14 → 16 → 18 → 20
  });

  test("stepping past a bound WRAPS to the other end", async () => {
    const { sessionState, click } = setup();
    sessionState.set(S1, KEY, "60"); // max
    await click(2);
    expect(sessionState.get(S1, KEY)).toBe("0"); // wrapped, not clamped to 60
  });

  test("a negative delta steps down", async () => {
    const { sessionState, click } = setup();
    sessionState.set(S1, KEY, "10");
    await click(-2);
    expect(sessionState.get(S1, KEY)).toBe("8");
  });

  test("a non-integer delta is BadVerbArgs (→ BAD_REQUEST)", async () => {
    const { ctx } = setup();
    const step = CLICK_VERBS.get(VERB_STEP_STATE)!;
    expect(() => step(encodeSegments(["s1", KEY, "x"]), ctx)).toThrow(
      BadVerbArgs,
    );
  });

  // Two configs declaring the same stepper differently are two gates: each
  // session steps from, and wraps at, what ITS config declares
  // (brandon-state-gates-lbs — the bounds were once every loaded config's,
  // merged to the widest).
  test("an unset key steps from the default of the config ITS session renders with", async () => {
    const stepIn = async (dflt: string): Promise<string | null> => {
      const { sessionState, click } = session(stepper(dflt));
      await click(2);
      return sessionState.get(S1, KEY);
    };
    expect(await stepIn("14")).toBe("16");
    expect(await stepIn("30")).toBe("32");
  });

  test("a step wraps at the bounds of the config ITS session renders with", async () => {
    const narrow = session(stepper("2", 0, 2));
    const wide = session(stepper("2", 0, 8));
    for (const s of [narrow, wide]) s.sessionState.set(S1, KEY, "2");
    await wide.click(2);
    await narrow.click(2);
    // From its own max, the narrow session wraps to its min; the wide one,
    // whose config declares room above 2, steps on.
    expect(narrow.sessionState.get(S1, KEY)).toBe("0");
    expect(wide.sessionState.get(S1, KEY)).toBe("4");
  });

  test("one key a word list in one config and a range in another gates each session by its own", async () => {
    const words = session({
      ...EMPTY_DEFAULT,
      actions: { pick: { set: KEY, from: ["warm", "cool"] } },
    });
    const range = session(stepper("14"));
    const set = CLICK_VERBS.get("set-state")!;
    await set(encodeSegments(["s1", KEY, "cool"]), words.ctx);
    expect(words.sessionState.get(S1, KEY)).toBe("cool");
    await range.click(2);
    expect(range.sessionState.get(S1, KEY)).toBe("16");
    // Each refuses what only the other's config declares.
    await expect(words.click(2)).rejects.toThrow(
      /not a bounded \(range\) state key/,
    );
    expect(() => set(encodeSegments(["s1", KEY, "cool"]), range.ctx)).toThrow(
      /must be an integer, got "cool"/,
    );
  });

  test("an unset key whose config shows a non-integer is refused, not stepped from min", async () => {
    const { sessionState, click } = session(stepper("wide"));
    await expect(click(2)).rejects.toThrow(
      /"step-test-hue" shows "wide" before any click/,
    );
    expect(sessionState.get(S1, KEY)).toBeNull();
  });

  test("a key the session's config declares no range for is rejected, not silently stepped", async () => {
    const step = CLICK_VERBS.get(VERB_STEP_STATE)!;
    const { ctx } = setup();
    expect(() =>
      step(encodeSegments(["s1", "not-a-stepper", "2"]), ctx),
    ).toThrow(BadVerbArgs);
  });

  test("step-state is a registered leaf verb", () => {
    expect(VERB_NAMES).toContain(VERB_STEP_STATE);
  });
});
