// [LAW:behavior-not-structure] Asserts the observable contract — the exact
// bytes a segment renders — never internal AST/cell structure.
//
// This is the verification substrate for the segment-DSL expressiveness proof
// (lit bzh.3). It does three things:
//   1. Asserts the registry covers exactly the canonical segment set.
//   2. Freezes each segment's legacy bytes as committed golden and guards
//      against drift (and, post-deletion, golden remains the canonical target).
//   3. Proves the byte-differ can both confirm parity and catch a mismatch.
// It deliberately migrates no segment (bzh.1 / vhi.3 own that).

import { VALID_SEGMENT_NAMES } from "../src/config/loader";
import { PARITY_REGISTRY } from "./parity/registry";
import {
  legacySegmentBytes,
  dslSegmentBytes,
  readGolden,
  writeGolden,
  UPDATE_GOLDEN,
  type GoldenMap,
  type SegmentBytes,
} from "./parity/harness";
import {
  makeRenderer,
  makeColors,
  makeResolver,
  FIXED_NOW_MS,
  ENV_VAR,
  ENV_VALUE,
} from "./parity/fixtures";
import { VariableStore } from "../src/var-system/store";

const renderer = makeRenderer();
const colors = makeColors();
const resolver = makeResolver();

// Pin the clock (weekly measures time-until-reset against it) and the env var
// the `env` segment reads, so every byte is reproducible.
beforeAll(() => {
  jest.useFakeTimers({ now: FIXED_NOW_MS });
  process.env[ENV_VAR] = ENV_VALUE;
});
afterAll(() => {
  jest.useRealTimers();
  delete process.env[ENV_VAR];
});

function liveLegacyGolden(): GoldenMap {
  const map: GoldenMap = {};
  for (const [name, entry] of Object.entries(PARITY_REGISTRY)) {
    map[name] = legacySegmentBytes(entry.legacy, renderer, colors);
  }
  return map;
}

// ─── Registry covers exactly the canonical segment set ───────────────────────

describe("parity registry completeness", () => {
  test("registry keys === VALID_SEGMENT_NAMES", () => {
    const registryNames = Object.keys(PARITY_REGISTRY).sort();
    const canonical = [...VALID_SEGMENT_NAMES].sort();
    expect(registryNames).toEqual(canonical);
  });
});

// ─── Golden regeneration (opt-in) ────────────────────────────────────────────

const maybe = UPDATE_GOLDEN ? describe : describe.skip;
maybe("golden regeneration", () => {
  test("write committed golden from live legacy bytes", () => {
    writeGolden(liveLegacyGolden());
  });
});

// ─── Per-segment proof ───────────────────────────────────────────────────────

// Skip the assertion suite while regenerating — golden is being (re)written.
const assertions = UPDATE_GOLDEN ? describe.skip : describe;
assertions("segment parity", () => {
  // Computed in beforeAll (not at describe-eval time) so that skipping this
  // suite during regeneration does not trigger the missing-golden read.
  let golden: GoldenMap;
  let live: GoldenMap;
  beforeAll(() => {
    golden = readGolden();
    live = liveLegacyGolden();
  });

  for (const [name, entry] of Object.entries(PARITY_REGISTRY)) {
    describe(name, () => {
      test("live legacy bytes match committed golden", () => {
        expect(live[name]).toEqual(golden[name]);
      });

      // [LAW:dataflow-not-control-flow] status is a value selecting the check.
      const dsl = entry.dsl;
      const provesParity = entry.status === "dsl-parity" && dsl !== undefined;
      (provesParity ? test : test.skip)(
        "DSL declaration is byte-identical to golden",
        () => {
          const bytes = dslSegmentBytes(dsl!, dsl!.store(), resolver);
          expect(bytes).toEqual(golden[name]);
        },
      );
    });
  }
});

// ─── Byte-differ self-test ───────────────────────────────────────────────────

// The differ's core promise: identical inputs → equal bytes; any difference →
// unequal bytes (a parity gap fails loudly). Proven without migrating a real
// segment, since bzh.3 ships none at parity.
describe("byte-differ", () => {
  function storeWith(value: string): VariableStore {
    const store = new VariableStore();
    store.defineBox("label", "string", value);
    return store;
  }
  const decl = { template: " {{ .label }} " };

  test("identical declaration + store → equal bytes", () => {
    const a = dslSegmentBytes({ decl, store: () => storeWith("main") }, storeWith("main"), resolver);
    const b = dslSegmentBytes({ decl, store: () => storeWith("main") }, storeWith("main"), resolver);
    expect(a).toEqual(b);
    expect((a as string).length).toBeGreaterThan(0);
  });

  test("deliberate mismatch → unequal bytes (loud)", () => {
    const a = dslSegmentBytes({ decl, store: () => storeWith("main") }, storeWith("main"), resolver);
    const b = dslSegmentBytes({ decl, store: () => storeWith("feature") }, storeWith("feature"), resolver);
    expect(a).not.toEqual(b);
  });

  // Cross-producer convergence: the real legacy producer (a stub SegmentData)
  // and a DSL declaration that reproduces it land on identical bytes through
  // the shared serializer. This is the existence proof that parity is reachable.
  //
  // Two requirements this proof documents for bzh.1:
  //   • the DSL must reproduce the one-space-each-side padding the legacy strip
  //     adds inside each cell — hence the leading/trailing spaces here;
  //   • the template must yield a SINGLE fragment, because fragmentsToStripCells
  //     emits one StripCell per plain fragment and the PowerlineJoiner then caps
  //     between them. `printf` collapses " %s " to one fragment; the natural
  //     form " {{ .t }} " fans out to three cells (leading-space, value,
  //     trailing-space) and does NOT converge. That fan-out is a real
  //     expressiveness gap, captured as a follow-up for the migration tier.
  test("legacy producer and DSL producer can converge on identical bytes", () => {
    const legacy = legacySegmentBytes(() => ({ text: "hello" }), renderer, colors);
    const store = new VariableStore();
    store.defineBox("t", "string", "hello");
    const dsl = dslSegmentBytes(
      { decl: { template: '{{ printf " %s " .t }}' }, store: () => store },
      store,
      resolver,
    );
    expect(dsl).toEqual(legacy);
  });
});
