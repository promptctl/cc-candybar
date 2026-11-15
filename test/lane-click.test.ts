// What a click hands the lane setup's owner: the clicking session's lane
// switches as the click found them and as its commit left them, measured by
// the click path itself (journaled, src/renderer/verbs/index.ts). No render,
// frame or other session's write is measured, so none can start a setup.

import { SessionState } from "../src/renderer/session-state";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { LANES, type Lane, type LaneSwitches } from "../src/config/lanes";
import type { VerbContext } from "../src/renderer/verbs";
import { clickUrl, recordRender, testVerbContext } from "./helpers/click";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import type { CheckedRenderRequest } from "../src/renderer-interface/request-context";

const SID = sessionIdOf("lane-click");
// The bundled bar, whose settings menu declares every lane's switch.
const CONFIG = parseAndValidate(
  "<test>",
  "{}",
  new Set(listResolvablePaletteNames()),
  DEFAULT_DSL_CONFIG,
);

interface Clicked {
  readonly sessionId: string;
  readonly latest: CheckedRenderRequest | null;
  readonly before: LaneSwitches;
  readonly after: LaneSwitches;
}

function rig(latest: CheckedRenderRequest | null = null) {
  const sessionState = new SessionState();
  recordRender(sessionState, SID);
  const base = testVerbContext(sessionState, undefined, CONFIG);
  const clicked: Clicked[] = [];
  const ctx: VerbContext = {
    ...base,
    latest,
    lanes: {
      ...base.lanes,
      clicked: (sessionId, latest, before, after) =>
        clicked.push({ sessionId, latest, before, after }),
    },
  };
  const toggle = async (sid: string, ...lanes: Lane[]): Promise<void> =>
    await clickUrl(
      effectsUrl(
        lanes.map((lane) => ({
          verb: VERB_SET_STATE,
          args: [
            sid,
            LANES[lane].switch.setting,
            String(LANES[lane].switch.on),
          ],
        })),
      ),
      ctx,
    );
  return { clicked, toggle };
}

const switches = (on: Partial<LaneSwitches>): LaneSwitches => ({
  band: false,
  statusline: false,
  pane: false,
  tmuxStatus: false,
  ...on,
});

test("a toggle's click hands over the switches before it and after its commit", async () => {
  const { clicked, toggle } = rig();
  await toggle(SID, "pane");
  expect(clicked).toEqual([
    {
      sessionId: SID,
      latest: null,
      before: switches({}),
      after: switches({ pane: true }),
    },
  ]);
});

test("a click hands over its session's newest request the host holds, whose hints name the pane a lane follows", async () => {
  // Only its identity is read here.
  const latest = { hints: {} } as CheckedRenderRequest;
  const { clicked, toggle } = rig(latest);
  await toggle(SID, "pane");
  expect(clicked.map((c) => c.latest)).toEqual([latest]);
});

test("a click of two lane toggles is one click: measured once, both lanes moved", async () => {
  const { clicked, toggle } = rig();
  await toggle(SID, "pane", "tmuxStatus");
  expect(clicked).toEqual([
    {
      sessionId: SID,
      latest: null,
      before: switches({}),
      after: switches({ pane: true, tmuxStatus: true }),
    },
  ]);
});

test("a click of a session that has never rendered measures nothing: it has no config to switch", async () => {
  const { clicked, toggle } = rig();
  await expect(toggle("never-rendered", "pane")).rejects.toThrow(
    /has not rendered yet/,
  );
  expect(clicked).toEqual([]);
});
