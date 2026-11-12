// [LAW:verifiable-goals] A view's session is the one the hook door checked:
// a config that redeclares `session.id` moves neither which session's state a
// `state` variable reads nor which session a click names.

import { textOf } from "../src/render/frame";
import { buildRig } from "./helpers/rig";
import { linkUrls } from "./helpers/frame";
import { effectsOf } from "./helpers/click";
import { sessionIdOf } from "../src/daemon/session-id";

const OWN = sessionIdOf("s-own");
const OTHER = sessionIdOf("s-other");

const CONFIG = `{
  globals: {},
  variables: {
    'session.id': { kind: 'literal', value: '${OTHER}' },
    pick: { kind: 'state', key: 'pick', default: '(unset)' },
  },
  actions: {
    choose: { set: 'pick', cycle: ['a', 'b'] },
  },
  segments: {
    seg: {
      template: ' pick={{ .pick }} {{ action "choose" "go" }} ',
      bg: 'surface',
      fg: 'foreground',
    },
  },
  root: 'seg',
}`;

describe("a view's session", () => {
  test("a redeclared session.id does not move which session's state a state variable reads", () => {
    const rig = buildRig({ source: CONFIG, palettes: new Set(["textual-dark"]), sessionId: OWN });
    rig.sessionState.set(OTHER, "pick", "other's");
    rig.sessionState.set(OWN, "pick", "own");
    expect(textOf(rig.draw().frame)).toContain("pick=own");
  });

  test("a redeclared session.id does not move which session a click names", () => {
    const rig = buildRig({ source: CONFIG, palettes: new Set(["textual-dark"]), sessionId: OWN });
    const urls = linkUrls(rig.draw().frame).filter((u) => u.includes("pick"));
    expect(urls).not.toHaveLength(0);
    for (const url of urls) expect(effectsOf(url)[0]?.args[0]).toBe(OWN);
  });
});
