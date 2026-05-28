// [LAW:single-enforcer] Tests the introspection contract — buildDebugSnapshot
// is the single function that projects daemon DSL state to the wire-level
// DebugSnapshot. Two scenarios:
//   (a) populated state: snapshots reflect a known DslConfig + store
//   (b) empty state (state===null): snapshots are well-formed and empty
//
// [LAW:verifiable-goals] Each test asserts a concrete inline shape — no
// fuzzy "contains" checks; the wire response shape is fixed by type.
//
// [LAW:dataflow-not-control-flow] No real socket setup; the introspector is
// a pure function over the DSL state bundle, so tests drive it with
// constructed state and read the result.

import {
  PROTOCOL_VERSION,
  encodeFrame,
  makeFrameReader,
} from "../src/daemon/protocol";
import type { Request, Response } from "../src/daemon/protocol";
import {
  DEBUG_WHATS,
  isDebugWhat,
} from "../src/daemon/debug-types";
import type { DebugSnapshot } from "../src/daemon/debug-types";
import {
  buildDebugSnapshot,
  extractReferencedVars,
  introspectConfig,
  introspectSegments,
  introspectVars,
  type DaemonDslState,
} from "../src/daemon/debug";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";

// ─── Fixtures ────────────────────────────────────────────────────────────────

// [LAW:verifiable-goals] The "unset env var" branch of declareEnv must be
// exercised deterministically. Relying on `CC_CANDYBAR_DEBUG_TEST_UNSET_VAR_XYZ`
// being absent in `process.env` was load-bearing on environment state; a CI
// runner or developer who happens to export it would silently flip the
// assertion. beforeEach/afterEach (below) own the env contract — they
// guarantee the variable is unset for every test in this file and restore
// any prior value on teardown.
const UNSET_ENV_VAR = "CC_CANDYBAR_DEBUG_TEST_UNSET_VAR_XYZ";

// A minimal DslConfig that exercises every snapshot field:
//   - literal (no source-side state)
//   - input (driven by applyInput payload, produces a value)
//   - env (resolved at declare time — UNSET_ENV_VAR is enforced absent so
//     this records a lastError and uses the per-variable default)
//   - template (computed node, depends on other vars)
const TEST_CONFIG_SOURCE = `{
  globals: {},
  variables: {
    greeting: { kind: 'literal', value: 'hello' },
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    user_path: { kind: 'env', name: '${UNSET_ENV_VAR}', default: '(unset)' },
    derived: { kind: 'template', template: '{{ .greeting }}, world' },
  },
  segments: {
    intro: {
      template: '{{ .greeting }} {{ .session.id }}',
      bg: 'surface',
      fg: 'foreground',
    },
    plain: {
      // No variable references — referencedVars must be empty for this one.
      template: ' static-text ',
      bg: 'surface',
      fg: 'foreground',
    },
  },
  layout: ['intro', 'plain'],
}`;

// [LAW:single-enforcer] env-state is managed at one place — these hooks —
// not scattered across each test. `declareEnv` reads `process.env` at
// registerDslConfig call time, so the env state is set *before* buildState
// is invoked from within each test.
let savedUnsetEnv: string | undefined;
beforeEach(() => {
  savedUnsetEnv = process.env[UNSET_ENV_VAR];
  delete process.env[UNSET_ENV_VAR];
});
afterEach(() => {
  if (savedUnsetEnv !== undefined) process.env[UNSET_ENV_VAR] = savedUnsetEnv;
  else delete process.env[UNSET_ENV_VAR];
});

// Build a populated DaemonDslState from the test config + a known payload.
function buildPopulatedState(): DaemonDslState {
  const config = parseAndValidate(
    "<debug-test>",
    TEST_CONFIG_SOURCE,
    new Set<string>(), // no palette validation needed — segments don't set one
  );
  const store = new VariableStore();
  const registry = new SourceRegistry(store);
  const compiled = registerDslConfig(config, registry, {
    cwd: process.cwd(),
  });
  // Apply a known payload so the 'session.id' input has a value.
  registry.applyInput({ session_id: "abc-123-def" });
  return {
    store,
    registry,
    config,
    compiled,
    lastRenderBySegment: new Map([
      // Pre-seed a last-render for one segment so we can verify the snapshot
      // surfaces it. The bzh.2 wiring will produce this map for real.
      ["intro", "(rendered output goes here)"],
    ]),
  };
}

// ─── DebugWhat boundary ──────────────────────────────────────────────────────

describe("DebugWhat", () => {
  test("DEBUG_WHATS lists exactly the supported values", () => {
    expect([...DEBUG_WHATS].sort()).toEqual(["config", "segments", "vars"]);
  });

  test("isDebugWhat narrows valid strings", () => {
    expect(isDebugWhat("vars")).toBe(true);
    expect(isDebugWhat("segments")).toBe(true);
    expect(isDebugWhat("config")).toBe(true);
  });

  test("isDebugWhat rejects everything else", () => {
    expect(isDebugWhat("")).toBe(false);
    expect(isDebugWhat("VARS")).toBe(false);
    expect(isDebugWhat(null)).toBe(false);
    expect(isDebugWhat(undefined)).toBe(false);
    expect(isDebugWhat(123)).toBe(false);
    expect(isDebugWhat({})).toBe(false);
  });
});

// ─── Empty state ─────────────────────────────────────────────────────────────

describe("buildDebugSnapshot with null state", () => {
  test("vars returns the empty vars shape", () => {
    const snap = buildDebugSnapshot("vars", null);
    expect(snap).toEqual({ what: "vars", vars: [] });
  });

  test("segments returns the empty segments shape", () => {
    const snap = buildDebugSnapshot("segments", null);
    expect(snap).toEqual({ what: "segments", segments: [] });
  });

  test("config returns null", () => {
    const snap = buildDebugSnapshot("config", null);
    expect(snap).toEqual({ what: "config", config: null });
  });
});

// ─── Populated state: vars ───────────────────────────────────────────────────

describe("introspectVars with populated state", () => {
  test("includes every declared variable, alphabetized", () => {
    const state = buildPopulatedState();
    const vars = introspectVars(state);
    const names = vars.map((v) => v.name);
    expect(names).toEqual(["derived", "greeting", "session.id", "user_path"]);
  });

  test("source kind matches the DSL declaration", () => {
    const state = buildPopulatedState();
    const vars = introspectVars(state);
    const byName = new Map(vars.map((v) => [v.name, v]));
    expect(byName.get("greeting")?.source).toBe("literal");
    expect(byName.get("session.id")?.source).toBe("input");
    expect(byName.get("user_path")?.source).toBe("env");
    expect(byName.get("derived")?.source).toBe("template");
  });

  test("current value reflects the live store", () => {
    const state = buildPopulatedState();
    const vars = introspectVars(state);
    const byName = new Map(vars.map((v) => [v.name, v]));
    expect(byName.get("greeting")?.value).toBe("hello");
    expect(byName.get("session.id")?.value).toBe("abc-123-def");
    // Unset env var falls back to the per-variable default.
    expect(byName.get("user_path")?.value).toBe("(unset)");
    // Template evaluates against the live store.
    expect(byName.get("derived")?.value).toBe("hello, world");
  });

  test("lastError is set for the unset env var, null otherwise", () => {
    const state = buildPopulatedState();
    const vars = introspectVars(state);
    const byName = new Map(vars.map((v) => [v.name, v]));
    // The env var with the unset name surfaces a lastError.
    const userPath = byName.get("user_path");
    expect(userPath?.lastError).not.toBeNull();
    expect(userPath?.lastError?.message).toContain(UNSET_ENV_VAR);
    expect(userPath?.lastError?.timestampMs).toBeGreaterThan(0);
    // Other vars resolved cleanly.
    expect(byName.get("greeting")?.lastError).toBeNull();
    expect(byName.get("session.id")?.lastError).toBeNull();
    expect(byName.get("derived")?.lastError).toBeNull();
  });

  test("ageMs is a non-negative number for box vars, null for computed", () => {
    const state = buildPopulatedState();
    const vars = introspectVars(state);
    const byName = new Map(vars.map((v) => [v.name, v]));
    // Literals, inputs, envs are all boxes — they have a real age.
    expect(byName.get("greeting")?.ageMs).toBeGreaterThanOrEqual(0);
    expect(byName.get("session.id")?.ageMs).toBeGreaterThanOrEqual(0);
    expect(byName.get("user_path")?.ageMs).toBeGreaterThanOrEqual(0);
    // 'derived' is a template → computed → age is null.
    expect(byName.get("derived")?.ageMs).toBeNull();
  });

  test("type matches each variable's declared type", () => {
    const state = buildPopulatedState();
    const vars = introspectVars(state);
    // Every variable in the fixture is string-typed.
    for (const v of vars) expect(v.type).toBe("string");
  });
});

// ─── Populated state: segments ───────────────────────────────────────────────

describe("introspectSegments with populated state", () => {
  test("includes every declared segment in layout order", () => {
    const state = buildPopulatedState();
    const segs = introspectSegments(state);
    expect(segs.map((s) => s.name)).toEqual(["intro", "plain"]);
  });

  test("template source is verbatim from config", () => {
    const state = buildPopulatedState();
    const segs = introspectSegments(state);
    const byName = new Map(segs.map((s) => [s.name, s]));
    expect(byName.get("intro")?.template).toBe(
      "{{ .greeting }} {{ .session.id }}",
    );
    expect(byName.get("plain")?.template).toBe(" static-text ");
  });

  test("referencedVars reflects template body for declared names only", () => {
    const state = buildPopulatedState();
    const segs = introspectSegments(state);
    const byName = new Map(segs.map((s) => [s.name, s]));
    expect(byName.get("intro")?.referencedVars).toEqual([
      "greeting",
      "session.id",
    ]);
    // A segment with no references reports an empty array.
    expect(byName.get("plain")?.referencedVars).toEqual([]);
  });

  test("lastRender comes from the daemon's per-segment map", () => {
    const state = buildPopulatedState();
    const segs = introspectSegments(state);
    const byName = new Map(segs.map((s) => [s.name, s]));
    expect(byName.get("intro")?.lastRender).toBe(
      "(rendered output goes here)",
    );
    // Not seeded → null, not undefined or empty string.
    expect(byName.get("plain")?.lastRender).toBeNull();
  });
});

// ─── extractReferencedVars: static analysis ──────────────────────────────────

describe("extractReferencedVars", () => {
  const declared = new Set([
    "greeting",
    "session.id",
    "git.branch",
    "user_path",
  ]);

  test("finds simple dotted refs inside actions", () => {
    expect(extractReferencedVars("{{ .greeting }}", declared)).toEqual([
      "greeting",
    ]);
  });

  test("finds multi-segment refs", () => {
    expect(extractReferencedVars("{{ .git.branch }}", declared)).toEqual([
      "git.branch",
    ]);
    expect(extractReferencedVars("{{ .session.id }}", declared)).toEqual([
      "session.id",
    ]);
  });

  test("ignores refs that do not match any declared name", () => {
    expect(
      extractReferencedVars("{{ .undeclared }}", declared),
    ).toEqual([]);
  });

  test("ignores '.' inside text outside actions", () => {
    expect(
      extractReferencedVars("static .greeting text", declared),
    ).toEqual([]);
  });

  test("dedups and sorts findings", () => {
    expect(
      extractReferencedVars(
        "{{ .greeting }} {{ .session.id }} {{ if .greeting }}{{ .git.branch }}{{ end }}",
        declared,
      ),
    ).toEqual(["git.branch", "greeting", "session.id"]);
  });

  test("credits ancestor when ref goes deeper than declared", () => {
    // `.session.id.extra` should still credit `session.id`.
    expect(
      extractReferencedVars("{{ .session.id.extra }}", declared),
    ).toEqual(["session.id"]);
  });

  test("handles pipeline forms", () => {
    expect(
      extractReferencedVars("{{ .greeting | upper }}", declared),
    ).toEqual(["greeting"]);
  });

  // [LAW:single-enforcer] String literals must NOT produce false positives.
  // The raw extractor (extractTemplateRefs in dsl-loader) strips string
  // literals from `{{ ... }}` bodies before scanning for dotted paths, so
  // a printf-style template containing a literal reference to a declared
  // name does not get falsely credited as a real reference.
  test("ignores dotted refs inside string literals", () => {
    // `.greeting` appears inside a string literal — must NOT be reported.
    expect(
      extractReferencedVars(`{{ printf ".greeting" }}`, declared),
    ).toEqual([]);
    // Same with single-quoted and backtick literals.
    expect(
      extractReferencedVars(`{{ printf '.greeting' }}`, declared),
    ).toEqual([]);
    expect(
      extractReferencedVars("{{ printf `.greeting` }}", declared),
    ).toEqual([]);
  });

  test("real ref outside a string literal still wins", () => {
    // The string contains a literal `.greeting`, but the action also reads
    // a real `.session.id` outside the literal. Only the real one is
    // reported.
    expect(
      extractReferencedVars(
        `{{ printf ".greeting=%s" .session.id }}`,
        declared,
      ),
    ).toEqual(["session.id"]);
  });
});

// ─── Populated state: config ─────────────────────────────────────────────────

describe("introspectConfig with populated state", () => {
  test("returns the parsed DslConfig", () => {
    const state = buildPopulatedState();
    const config = introspectConfig(state);
    expect(config).not.toBeNull();
    expect(config?.layout).toEqual(["intro", "plain"]);
    expect(Object.keys(config?.variables ?? {}).sort()).toEqual([
      "derived",
      "greeting",
      "session.id",
      "user_path",
    ]);
    expect(Object.keys(config?.segments ?? {}).sort()).toEqual([
      "intro",
      "plain",
    ]);
  });

  test("round-trips through JSON without losing shape", () => {
    // The introspectConfig result becomes a JSON wire frame. Round-tripping
    // through JSON.stringify/JSON.parse must preserve every observable field.
    const state = buildPopulatedState();
    const config = introspectConfig(state);
    const wireShape = JSON.parse(JSON.stringify(config));
    expect(wireShape.layout).toEqual(["intro", "plain"]);
    expect(wireShape.variables.greeting.kind).toBe("literal");
    expect(wireShape.segments.intro.template).toBe(
      "{{ .greeting }} {{ .session.id }}",
    );
  });
});

// ─── Wire-format round-trip ──────────────────────────────────────────────────

describe("Debug protocol wire format", () => {
  test("DebugRequest serializes with correct kind", () => {
    const req: Request = {
      v: PROTOCOL_VERSION,
      kind: "debug",
      what: "vars",
    };
    const encoded = encodeFrame(req);
    const len = encoded.readUInt32BE(0);
    const body = JSON.parse(encoded.subarray(4, 4 + len).toString("utf8"));
    expect(body.v).toBe(PROTOCOL_VERSION);
    expect(body.kind).toBe("debug");
    expect(body.what).toBe("vars");
  });

  test("DebugResponse with vars snapshot round-trips", async () => {
    const snap: DebugSnapshot = {
      what: "vars",
      vars: [
        {
          name: "greeting",
          source: "literal",
          type: "string",
          value: "hello",
          lastError: null,
          ageMs: 5,
        },
      ],
    };
    const response: Response = { ok: true, debug: snap };
    const decoded = await decodeFrame(encodeFrame(response));
    expect(decoded).toEqual(response);
  });

  test("DebugResponse with config snapshot round-trips", async () => {
    const state = buildPopulatedState();
    const response: Response = {
      ok: true,
      debug: { what: "config", config: introspectConfig(state) },
    };
    const decoded = await decodeFrame(encodeFrame(response));
    // The DslConfig is JSON-shaped throughout (no Map, no class instance),
    // so structural equality holds across the round-trip.
    expect(decoded).toEqual(JSON.parse(JSON.stringify(response)));
  });
});

// ─── PROTOCOL_VERSION discipline: additive ≠ breaking ───────────────────────

describe("PROTOCOL_VERSION", () => {
  // [LAW:types-are-the-program] PROTOCOL_VERSION carries one theorem:
  // "old-and-new cannot communicate." Adding a new request kind does not
  // change that theorem — old clients don't send the new kind, and old
  // daemons reject it via BAD_REQUEST fallthrough (the additive negotiation,
  // no separate capabilities exchange needed). Bumping on additive changes
  // taxed every running session with a VERSION_MISMATCH on rebuild — the
  // 452-corpse precedent (kz8.5) refuses to kick on permanent errors, so a
  // bumped version forces visible breakage until each session restarts.
  // This test pins the discipline so a future additive change cannot
  // silently re-bump.
  test("the debug kind is additive — no bump from prior protocol", () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function decodeFrame(buf: Buffer): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reader = makeFrameReader(
      (frame) => resolve(frame),
      (err) => reject(err),
    );
    reader(buf);
  });
}
