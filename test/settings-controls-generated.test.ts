// [LAW:verifiable-goals] brandon-settings-coverage-g4p.zoj — the settings
// menu's controls are generated from the `globals` declarations, not
// hand-listed. Measured through the real loader, the real synthesis, the real
// spine and the real derived write gates:
//
//   - every globals field is either controlled or opted out, never both
//     (the compile-time half is UNCONTROLLED_GLOBALS' key type);
//   - every controlled field's control writes its session key through a gate
//     that admits exactly the domain the loader declares for the field;
//   - a global the menu has never seen — a throwaway enum — gets a working
//     control from the same generator, with its option domain and its gate.

import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { stateGate } from "../src/daemon/verbs/state-validators";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import {
  SETTINGS,
  UNCONTROLLED_GLOBALS,
} from "../src/config/setting-projections";
import {
  globalsControlDomain,
  globalsJson,
  listGlobalsFieldNames,
} from "../src/config/loader/globals";
import {
  perConfigDomainsFor,
  resolveOptionDomain,
} from "../src/config/option-domain";
import { settingControl } from "../src/config/setting-control";
import type { ActionDecl } from "../src/config/action";
import type { ValidatedConfig as DslConfig } from "../src/config/dsl-types";
import {
  clickUrl,
  effectsOf,
  recordRender,
  testVerbContext,
} from "./helpers/click";
import { linkUrls, stripAnsi } from "./helpers/ansi";

const ALLOWED = new Set(listResolvablePaletteNames());
const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};
const PAYLOAD = { session_id: "s1", workspace: { current_dir: "/tmp/proj" } };

function load(src: string): DslConfig {
  return parseAndValidate("<user>", src, ALLOWED, DEFAULT_DSL_CONFIG);
}

// The actions of a config that write `key` in the session.
const writersOf = (config: DslConfig, key: string): ActionDecl[] =>
  Object.values(config.actions).filter(
    (a) => "set" in a && (a as { set: string }).set === key,
  );

describe("every globals field is controlled or opted out", () => {
  const controlled = Object.values(SETTINGS).map((row) => row.configKey);
  const optedOut = Object.keys(UNCONTROLLED_GLOBALS);

  test("the two lists partition the globals fields", () => {
    expect([...controlled, ...optedOut].sort()).toEqual(
      [...listGlobalsFieldNames()].sort(),
    );
  });

  test("an opted-out field has no control: nothing on the bar writes it", () => {
    const config = load("{}");
    for (const field of optedOut) {
      expect(writersOf(config, field)).toEqual([]);
    }
  });
});

describe("each controlled field's control is generated from its declared domain", () => {
  const config = load("{}");
  const perConfig = perConfigDomainsFor(config);
  // What the LOADER accepts for each field, read from its emitted schema —
  // the other interpreter of the field's spec.
  const accepted = (
    globalsJson() as {
      properties: Record<
        string,
        { enum?: string[]; type?: string; minimum?: number; maximum?: number }
      >;
    }
  ).properties;

  for (const [name, row] of Object.entries(SETTINGS)) {
    test(`${name}: its control's gate is the domain globals.${row.configKey} declares`, () => {
      const domain = globalsControlDomain(row.configKey);
      if (domain === "text") throw new Error(`${name} is free text`);
      // The control offers exactly what the loader accepts for the field.
      const schema = accepted[row.configKey]!;
      if (schema.enum !== undefined) {
        expect("from" in (domain as object)).toBe(true);
        const { from } = domain as { from: string | readonly string[] };
        expect(resolveOptionDomain(from, perConfig).members).toEqual(
          schema.enum,
        );
      } else if (schema.type === "boolean") {
        expect(domain).toBe("bool");
      } else if (schema.type === "integer") {
        expect(domain).toMatchObject({
          min: schema.minimum,
          max: schema.maximum,
        });
      }
      // One control per setting — a ring's action ranges the declared domain
      // — and a ↺ that resets its config field.
      const writers = writersOf(config, row.sessionKey);
      expect(writers.length).toBeGreaterThan(0);
      if (typeof domain === "object" && "from" in domain) {
        expect(writers).toContainEqual({
          set: row.sessionKey,
          from: domain.from,
        });
      }
      expect(
        Object.values(config.actions).some(
          (a) => "reset" in a && a.reset === row.configKey,
        ),
      ).toBe(true);
      const gate = stateGate(config);
      const admit = (value: string) => gate.validate(row.sessionKey, value);
      if (domain === "bool") {
        expect(admit("true").ok).toBe(true);
        expect(admit("false").ok).toBe(true);
        expect(admit("yes").ok).toBe(false);
      } else if ("from" in domain) {
        const { members } = resolveOptionDomain(domain.from, perConfig);
        expect(members.length).toBeGreaterThan(0);
        for (const member of members) expect(admit(member).ok).toBe(true);
        expect(admit("no-such-member").ok).toBe(false);
      } else {
        // A range gate clamps a value past its bound into the range.
        expect(admit(String(domain.max + 5))).toEqual({
          ok: true,
          value: String(domain.max),
        });
        expect(admit(String(domain.min))).toEqual({
          ok: true,
          value: String(domain.min),
        });
      }
    });
  }
});

describe("a global the menu has never seen gets its control from the generator", () => {
  // A throwaway enum global: its declaration, fed through the SAME generator
  // the settings menu builds every control with, into a real config.
  const control = settingControl(
    { label: "🧪", domain: { from: ["low", "mid", "high"] } },
    "zoom",
    "zoom",
    "apply.zoom",
    "zoom.list",
  );
  const { actions } = control;

  test("an enum becomes a picker over exactly its members", () => {
    expect(control.kind).toBe("picker");
    // The setting's own write, from exactly the declared members — beside it
    // only the list's machinery: its toggle, its page cursor, and the one
    // click opening it at the first page.
    expect(actions["apply.zoom"]).toEqual({
      set: "zoom",
      from: ["low", "mid", "high"],
    });
    const writes = Object.values(actions).flatMap((a) =>
      "set" in a ? [a.set] : [],
    );
    expect(new Set(writes)).toEqual(
      new Set(["zoom", "zoom.list", "zoom.list.page"]),
    );
  });

  test("the picker names the current member between its arrows, lists every member, and its gate admits exactly them", () => {
    if (control.kind !== "picker") throw new Error("not a picker");
    // The list is a row of the body the control opens; here it is laid as the
    // next row, open, so both render.
    const config = load(`{
      variables: ${JSON.stringify({
        zoom: { kind: "state", key: "zoom", default: "mid" },
        ...control.variables,
        "zoom.list": { kind: "state", key: "zoom.list", default: "apply.zoom" },
      })},
      actions: ${JSON.stringify(actions)},
      segments: {
        zoomer: { template: ${JSON.stringify(control.template)} },
        zoomlist: { template: ${JSON.stringify(control.list.template)} },
      },
      root: { v: ['zoomer', 'zoomlist'] },
    }`);
    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, sessionState);
    const compiled = registerDslConfig(config, registry, { cwd: "/tmp/proj" });
    const render = () =>
      renderDsl(config, compiled, store, registry, PAYLOAD, OPTS);
    const gate = stateGate(config);
    expect(gate.validate("zoom", "high").ok).toBe(true);
    expect(gate.validate("zoom", "max").ok).toBe(false);
    const out = render();
    const [trigger, list] = stripAnsi(out).split("\n");
    // No neighbours beside the arrows: the list is where the members are.
    expect(trigger).toContain("◀ mid ▶");
    expect(trigger).not.toMatch(/low|high/);
    expect(list).toMatch(/low mid high/);
    // The list draws no ✕ of its own: the body it is a row of closes it.
    expect(list).not.toContain("✕");
    // The name is the list's toggle: open here, so its click closes it.
    expect(
      linkUrls(out).some((u) =>
        effectsOf(u).some(
          (e) => e.args[1] === "zoom.list" && e.args[2] === "closed",
        ),
      ),
    ).toBe(true);
    const high = linkUrls(out).find((u) =>
      effectsOf(u).some((e) => e.args[1] === "zoom" && e.args[2] === "high"),
    );
    recordRender(sessionState, "s1");
    clickUrl(high!, testVerbContext(sessionState, undefined, config));
    expect(sessionState.get("s1", "zoom")).toBe("high");
  });
});
