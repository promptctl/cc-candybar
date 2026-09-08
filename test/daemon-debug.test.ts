// [LAW:single-enforcer] buildDebugSnapshot is the one projection of daemon DSL
// state to the wire-level DebugSnapshot.
// [LAW:verifiable-goals] Each test asserts a concrete inline shape.
// [LAW:dataflow-not-control-flow] The introspector is pure over the state bundle.

import { SessionState } from "../src/daemon/session-state";
import { ownDeclNames } from "./helpers/ambient-chrome";
import {
  PROTOCOL_VERSION,
  encodeFrame,
  makeFrameReader,
} from "../src/daemon/protocol";
import type { Request, Response } from "../src/daemon/protocol";
import { DEBUG_WHATS, isDebugWhat } from "../src/daemon/debug-types";
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
import { rootOf } from "../src/config/root";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { ABSENT, failed, ok } from "../src/utils/outcome";

// [LAW:verifiable-goals] The unset-env branch must not depend on ambient env;
// the hooks below own that contract.
const UNSET_ENV_VAR = "CC_CANDYBAR_DEBUG_TEST_UNSET_VAR_XYZ";

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
  root: { h: ['intro', 'plain'] },
}`;

// [LAW:single-enforcer] declareEnv reads process.env at registerDslConfig time,
// so these hooks own the env contract for every test in this file.
let savedUnsetEnv: string | undefined;
beforeEach(() => {
  savedUnsetEnv = process.env[UNSET_ENV_VAR];
  delete process.env[UNSET_ENV_VAR];
});
afterEach(() => {
  if (savedUnsetEnv !== undefined) process.env[UNSET_ENV_VAR] = savedUnsetEnv;
  else delete process.env[UNSET_ENV_VAR];
});

function buildPopulatedState(): DaemonDslState {
  const config = parseAndValidate(
    "<debug-test>",
    TEST_CONFIG_SOURCE,
    new Set<string>(),
  );
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  const compiled = registerDslConfig(config, registry, {
    cwd: process.cwd(),
  });
  registry.applyInput({ session_id: "abc-123-def" });
  return {
    store,
    registry,
    config,
    compiled,
    lastRenderBySegment: new Map([
      ["intro", "(rendered output goes here)"],
    ]),
  };
}

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

describe("introspectVars with populated state", () => {
  test("includes every declared variable, alphabetized", () => {
    const state = buildPopulatedState();
    const vars = introspectVars(state);
    const names = ownDeclNames(vars.map((v) => v.name));
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
    expect(byName.get("user_path")?.value).toBe("(unset)");
    expect(byName.get("derived")?.value).toBe("hello, world");
  });

  test("lastError is set for the unset env var, null otherwise", () => {
    const state = buildPopulatedState();
    const vars = introspectVars(state);
    const byName = new Map(vars.map((v) => [v.name, v]));
    const userPath = byName.get("user_path");
    expect(userPath?.lastError).not.toBeNull();
    expect(userPath?.lastError?.message).toContain(UNSET_ENV_VAR);
    expect(userPath?.lastError?.timestampMs).toBeGreaterThan(0);
    expect(byName.get("greeting")?.lastError).toBeNull();
    expect(byName.get("session.id")?.lastError).toBeNull();
    expect(byName.get("derived")?.lastError).toBeNull();
  });

  test("ageMs is a non-negative number for box vars, null for computed", () => {
    const state = buildPopulatedState();
    const vars = introspectVars(state);
    const byName = new Map(vars.map((v) => [v.name, v]));
    expect(byName.get("greeting")?.ageMs).toBeGreaterThanOrEqual(0);
    expect(byName.get("session.id")?.ageMs).toBeGreaterThanOrEqual(0);
    expect(byName.get("user_path")?.ageMs).toBeGreaterThanOrEqual(0);
    expect(byName.get("derived")?.ageMs).toBeNull();
  });

  test("type matches each variable's declared type", () => {
    const state = buildPopulatedState();
    const vars = introspectVars(state);
    // Chrome the bar synthesizes brings its own types, hence the own-decls filter.
    const own = new Set(ownDeclNames(vars.map((v) => v.name)));
    for (const v of vars.filter((v) => own.has(v.name)))
      expect(v.type).toBe("string");
  });
});

describe("introspectVars — documents", () => {
  test("a document snapshots as its canonical JSON text, or the state a template read would surface", () => {
    const state = buildPopulatedState();
    state.store.defineDocument("doc.ok", ok({ b: 2, a: { c: 1 } }));
    state.store.defineDocument("doc.absent", ABSENT);
    state.store.defineDocument("doc.failed", failed("JSON parse failed: x"));
    const byName = new Map(introspectVars(state).map((v) => [v.name, v]));
    expect(byName.get("doc.ok")).toMatchObject({
      type: "document",
      value: '{"a":{"c":1},"b":2}',
    });
    expect(byName.get("doc.absent")).toMatchObject({
      type: "document",
      value: "(not yet scanned)",
    });
    expect(byName.get("doc.failed")).toMatchObject({
      type: "document",
      value: "JSON parse failed: x",
    });
  });
});

describe("introspectSegments with populated state", () => {
  test("includes every declared segment in layout order", () => {
    const state = buildPopulatedState();
    const segs = introspectSegments(state);
    expect(ownDeclNames(segs.map((s) => s.name))).toEqual(["intro", "plain"]);
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
    expect(byName.get("plain")?.referencedVars).toEqual([]);
  });

  test("lastRender comes from the daemon's per-segment map", () => {
    const state = buildPopulatedState();
    const segs = introspectSegments(state);
    const byName = new Map(segs.map((s) => [s.name, s]));
    expect(byName.get("intro")?.lastRender).toBe("(rendered output goes here)");
    expect(byName.get("plain")?.lastRender).toBeNull();
  });
});

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
    expect(extractReferencedVars("{{ .undeclared }}", declared)).toEqual([]);
  });

  test("ignores '.' inside text outside actions", () => {
    expect(extractReferencedVars("static .greeting text", declared)).toEqual(
      [],
    );
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
    expect(extractReferencedVars("{{ .session.id.extra }}", declared)).toEqual([
      "session.id",
    ]);
  });

  test("handles pipeline forms", () => {
    expect(extractReferencedVars("{{ .greeting | upper }}", declared)).toEqual([
      "greeting",
    ]);
  });

  // [LAW:single-enforcer] The raw extractor strips string literals before
  // scanning, so a literal name is never credited as a reference.
  test("ignores dotted refs inside string literals", () => {
    expect(extractReferencedVars(`{{ printf ".greeting" }}`, declared)).toEqual(
      [],
    );
    expect(extractReferencedVars(`{{ printf '.greeting' }}`, declared)).toEqual(
      [],
    );
    expect(extractReferencedVars("{{ printf `.greeting` }}", declared)).toEqual(
      [],
    );
  });

  test("real ref outside a string literal still wins", () => {
    expect(
      extractReferencedVars(
        `{{ printf ".greeting=%s" .session.id }}`,
        declared,
      ),
    ).toEqual(["session.id"]);
  });
});

describe("introspectConfig with populated state", () => {
  test("returns the parsed DslConfig", () => {
    const state = buildPopulatedState();
    const config = introspectConfig(state);
    expect(config).not.toBeNull();
    expect(config?.root).toEqual(rootOf({
      kind: "container",
      direction: "horizontal",
      children: [
        { kind: "segment", name: "intro" },
        { kind: "segment", name: "plain" },
      ],
    }));
    expect(ownDeclNames(Object.keys(config?.variables ?? {})).sort()).toEqual([
      "derived",
      "greeting",
      "session.id",
      "user_path",
    ]);
    expect(ownDeclNames(Object.keys(config?.segments ?? {})).sort()).toEqual([
      "intro",
      "plain",
    ]);
  });

  test("round-trips through JSON without losing shape", () => {
    const state = buildPopulatedState();
    const config = introspectConfig(state);
    const wireShape = JSON.parse(JSON.stringify(config));
    expect(wireShape.root).toEqual(rootOf({
      kind: "container",
      direction: "horizontal",
      children: [
        { kind: "segment", name: "intro" },
        { kind: "segment", name: "plain" },
      ],
    }));
    expect(wireShape.variables.greeting.kind).toBe("literal");
    expect(wireShape.segments.intro.template).toBe(
      "{{ .greeting }} {{ .session.id }}",
    );
  });
});

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
    // The DslConfig is JSON-shaped throughout, so structural equality holds.
    expect(decoded).toEqual(JSON.parse(JSON.stringify(response)));
  });
});

describe("PROTOCOL_VERSION", () => {
  // [LAW:types-are-the-program] PROTOCOL_VERSION carries one theorem: old and
  // new cannot communicate. A new request kind is additive, so it must not bump.
  test("the debug kind is additive — no bump from prior protocol", () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });
});

function decodeFrame(buf: Buffer): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reader = makeFrameReader(
      (frame) => resolve(frame),
      (err) => reject(err),
    );
    reader(buf);
  });
}
