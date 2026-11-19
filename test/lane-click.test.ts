import { SessionState } from "../src/renderer/session-state";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { LANES } from "../src/config/lanes";
import {
  clickUrl,
  hearRender,
  heardRequest,
  recordRender,
  testVerbContext,
} from "./helpers/click";
import { sessionIdOf } from "../src/daemon/foundations/session-id";

const SID = sessionIdOf("lane-click");
const CONFIG = parseAndValidate(
  "<test>",
  "{}",
  DEFAULT_DSL_CONFIG,
);

test.each([true, false])(
  "display controls record settings without sending commands (live=%s)",
  async (live) => {
    const state = new SessionState();
    if (live) hearRender(state, heardRequest(SID));
    else recordRender(state, SID);
    const ctx = testVerbContext(state, undefined, CONFIG);
    const switches = Object.values(LANES).map((lane) => lane.switch);
    await clickUrl(
      effectsUrl(
        switches.map(({ setting, on }) => ({
          verb: VERB_SET_STATE,
          args: [SID, setting, String(on)],
        })),
      ),
      ctx,
    );
    for (const { setting, on } of switches)
      expect(state.get(SID, setting)).toBe(String(on));
    expect(ctx.effects).toEqual([]);
  },
);
