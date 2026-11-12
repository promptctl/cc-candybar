// [LAW:verifiable-goals] A view's session is the one the hook door checked:
// `{{ .session.id }}`, a `state` variable and a click all name it, and no
// config can declare a `session.id` of its own.

import { textOf } from "../src/render/frame";
import { buildRig } from "./helpers/rig";
import { linkUrls } from "./helpers/frame";
import { effectsOf } from "./helpers/click";
import { sessionIdOf } from "../src/daemon/session-id";
import { parseDslConfig } from "../src/config/dsl-loader";
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

  test("a config declaring session.id does not load", () => {
    expect(() =>
      parseDslConfig(
        "t.json5",
        `{ variables: { 'session.id': { kind: 'literal', value: '${OTHER}' } } }`,
      ),
    ).toThrow("\"session.id\" is supplied by the daemon's payload");
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
    "a config declaring the payload input %s does not load",
    (name) => {
      expect(() =>
        parseDslConfig(
          "t.json5",
          `{ variables: { ${JSON.stringify(name)}: { kind: 'literal', value: 'x' } } }`,
        ),
      ).toThrow(`"${name}" is supplied by the daemon's payload`);
    },
  );
});
