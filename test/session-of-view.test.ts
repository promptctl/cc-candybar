// [LAW:verifiable-goals] A view's session is the one the hook door checked:
// `{{ .session.id }}`, a `state` variable and a click all name it, and no
// config can declare a `session.id` of its own.

import { textOf } from "../src/render/frame";
import { buildRig } from "./helpers/rig";
import { linkUrls } from "./helpers/frame";
import { effectsOf } from "./helpers/click";
import { sessionIdOf } from "../src/daemon/session-id";
import {
  ConfigError,
  loadConfigSource,
  noProject,
  parseDslConfig,
} from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { PAYLOAD_INPUTS } from "../src/config/payload-inputs";

const OWN = sessionIdOf("s-own");
const OTHER = sessionIdOf("s-other");

const CONFIG = `{
  globals: {},
  variables: {
    pick: { kind: 'state', key: 'pick', default: '(unset)' },
  },
  actions: {
    choose: { set: 'pick', cycle: ['a', 'b'] },
  },
  segments: {
    seg: {
      template: ' sid={{ .session.id }} pick={{ .pick }} {{ action "choose" "go" }} ',
      bg: 'surface',
      fg: 'foreground',
    },
  },
  root: 'seg',
}`;

describe("a view's session", () => {
  test("a state variable reads the view's own session", () => {
    const rig = buildRig({
      source: CONFIG,
      palettes: new Set(["textual-dark"]),
      sessionId: OWN,
    });
    rig.sessionState.set(OTHER, "pick", "other's");
    rig.sessionState.set(OWN, "pick", "own");
    expect(textOf(rig.draw().frame)).toContain("pick=own");
  });

  test("a write to the view's own session moves its next draw", () => {
    const rig = buildRig({
      source: CONFIG,
      palettes: new Set(["textual-dark"]),
      sessionId: OWN,
    });
    expect(textOf(rig.draw().frame)).toContain("pick=(unset)");
    rig.sessionState.set(OWN, "pick", "own");
    expect(textOf(rig.draw().frame)).toContain("pick=own");
  });

  test("a click names the view's own session", () => {
    const rig = buildRig({
      source: CONFIG,
      palettes: new Set(["textual-dark"]),
      sessionId: OWN,
    });
    const writes = linkUrls(rig.draw().frame)
      .map((u) => effectsOf(u)[0])
      .filter((e) => e?.args[1] === "pick");
    expect(writes).not.toHaveLength(0);
    for (const write of writes) expect(write?.args[0]).toBe(OWN);
  });

  test("a template's {{ .session.id }} is the view's own session", () => {
    const rig = buildRig({
      source: CONFIG,
      palettes: new Set(["textual-dark"]),
      sessionId: OWN,
    });
    expect(textOf(rig.draw().frame)).toContain(`sid=${OWN}`);
  });

  test("a config's own session.id is ignored with a warning, and the bar draws the view's session", () => {
    const declared = CONFIG.replace(
      "variables: {",
      `variables: { 'session.id': { kind: 'literal', value: '${OTHER}' },`,
    );
    const loaded = loadConfigSource(
      "t.json5",
      declared,
      DEFAULT_DSL_CONFIG,
      noProject("/home"),
      new Set(["textual-dark"]),
    );
    expect(loaded.warnings).toEqual([
      expect.stringMatching(
        /^t\.json5:\d+: "session\.id" is supplied by the daemon's payload/,
      ),
    ]);
    const rig = buildRig({
      source: declared,
      palettes: new Set(["textual-dark"]),
      sessionId: OWN,
    });
    expect(textOf(rig.draw().frame)).toContain(`sid=${OWN}`);
  });

  test("a refused file's error carries the session.id warning beside it", () => {
    let caught: unknown;
    try {
      parseDslConfig(
        "t.json5",
        `{ bogus: 1, variables: { 'session.id': { kind: 'literal', value: 'x' } } }`,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).warnings).toEqual([
      expect.stringContaining(
        `"session.id" is supplied by the daemon's payload`,
      ),
    ]);
  });

  test("a segment var named into session.id does not load", () => {
    expect(() =>
      parseDslConfig(
        "t.json5",
        `{ segments: { session: { template: 'x', vars: { id: { kind: 'literal', value: 'x' } } } } }`,
      ),
    ).toThrow(`segment "session"'s var "id" is named "session.id"`);
  });

  test.each(Object.keys(PAYLOAD_INPUTS))(
    "a config's own declaration of the payload input %s is ignored with a warning",
    (name) => {
      const loaded = loadConfigSource(
        "t.json5",
        `{ variables: { ${JSON.stringify(name)}: { kind: 'literal', value: 'x' } } }`,
        DEFAULT_DSL_CONFIG,
        noProject("/home"),
      );
      expect(loaded.config.variables[name]).toEqual(PAYLOAD_INPUTS[name]);
      expect(loaded.warnings).toEqual([
        expect.stringContaining(
          `"${name}" is supplied by the daemon's payload`,
        ),
      ]);
    },
  );
});
