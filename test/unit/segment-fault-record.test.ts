// [LAW:verifiable-goals] A placement that cannot draw shows its ⚠ cell, and
// its whole message reaches the two places a reader without the cell looks:
// the bar's ⚠ list, whose viewer shows it, and the turn record, whose
// `faults` note lists it once and says `kept` while nothing moved. Driven
// through the main renderer as its host drives it, over in-memory storage.

import { TEST_ENV } from "../helpers/session-environment";
import type { ConfigSnapshot } from "../../src/config/config-snapshot";
import { clickOf, linksOf } from "../../src/click/read";
import { PRESET_FLOOR } from "../../src/config/presets";
import { FACTS_VERSION } from "../../src/daemon/facts-assembly";
import { PROTOCOL_VERSION } from "../../src/daemon/foundations/protocol";
import type { SessionId } from "../../src/daemon/foundations/session-id";
import { checkRenderRequest } from "../../src/daemon/render-checkpoint";
import type { WorldState } from "../../src/facts/world-state";
import { textOf, type Frame } from "../../src/render/frame";
import type {
  Effect,
  Event,
  Present,
  Renderer,
  RendererOutput,
  RequestId,
} from "../../src/renderer-interface/interface";
import { readFaults } from "../../src/renderer-interface/noted-faults";
import type { CheckedRenderRequest } from "../../src/renderer-interface/request-context";
import { EMPTY_STORED_STATE } from "../../src/renderer-interface/stored-state";
import { mainRendererOf } from "../../src/renderer/main";
import { instantOf, type Tick } from "../../src/utils/instant";
import { ABSENT, pendingOf } from "../../src/utils/outcome";
import { daemonFactsOf } from "../helpers/daemon-facts";
import { bareGates } from "../helpers/gates";
import { TEST_SIGNER } from "../helpers/link-signer";
import { NO_PLUGIN_STORAGE } from "../helpers/plugin-storage";
import { viewFacts } from "../helpers/view-facts";

const AT = instantOf(new Date(1_700_000_000_000));
const READ = { at: AT, tick: 0 as Tick };
const PROJECT = "/nowhere/project";
const USER_FILE = "/nowhere/config/cc-candybar/config.json5";
const MESSAGE = "the placement broke on purpose";
const CONFIG = `{
  segments: { broken: { template: '{{ fail "${MESSAGE}" }}' } },
  root: { h: ["broken"] },
}`;

const rendererOf = (): Renderer =>
  mainRendererOf(
    {
      stored: EMPTY_STORED_STATE,
      linkSigner: TEST_SIGNER,
      locations: {
        home: "/nowhere/home",
        configHome: "/nowhere/config",
        dataHome: "/nowhere/data",
        dataDirs: [],
      },
      home: "/nowhere/home",
      gates: bareGates(),
      memoryLimitBytes: 1024 * 1024 * 1024,
    },
    {
      log: () => {},
      eventAnswered: () => {},
      storage: NO_PLUGIN_STORAGE,
    },
  );

function contextOf(session: string): CheckedRenderRequest {
  const checked = checkRenderRequest(
    {
      v: PROTOCOL_VERSION,
      kind: "render",
      hookData: viewFacts(PROJECT, session).hookData,
      args: ["cc-candybar"],
      cwd: PROJECT,
      encoding: "frame",
      env: TEST_ENV,
    },
    { firstSightOfUnknownHookField: () => false },
    () => {},
    "/nowhere/home",
  );
  if (!checked.ok) throw new Error(checked.problems.join("; "));
  return checked.req;
}

function worldStateOf(session: SessionId): WorldState {
  const absent = { ...ABSENT, at: AT };
  return {
    v: FACTS_VERSION,
    session,
    seq: 1,
    builtins: {
      session: absent,
      today: absent,
      speed: absent,
      context: absent,
      metrics: absent,
      activity: absent,
      cache: absent,
      autocompact: absent,
      git: absent,
      pr: absent,
      tmux: absent,
      hostName: absent,
      hostUser: absent,
    },
    sources: {},
    runs: {},
    env: {},
    doctor: pendingOf("unread"),
    daemon: daemonFactsOf(),
    diagnostics: [],
  };
}

const snapshotOf = (text: string): ConfigSnapshot => ({
  chain: [
    {
      role: "user",
      path: USER_FILE,
      content: { kind: "text", text },
      listed: {},
    },
  ],
  repo: null,
  plugins: [],
  strays: [],
  checkout: { root: PROJECT, git: false },
  notices: [],
  watch: null,
});

const handIn = (r: Renderer, event: Event): Promise<RendererOutput> =>
  r.answer({ kind: "event", ...READ, event });

const answered = (output: RendererOutput) => {
  if (output.kind !== "answered")
    throw new Error(`the turn threw: ${output.failure.detail}`);
  return output;
};

const presentOf = (effects: readonly Effect[]): Present => {
  const present = effects.find((e): e is Present => e.kind === "present");
  if (present === undefined) throw new Error("no present among the effects");
  return present;
};

const noted = (output: RendererOutput, field: string): string => {
  const found = output.record.find(([key]) => key === field);
  if (found === undefined) throw new Error(`the record notes no ${field}`);
  return String(found[1]);
};

// The bar's indicator: the link wearing the error glyph.
const indicatorOf = (frame: Pick<Frame, "rows">) =>
  linksOf(frame).find(({ text }) => text.startsWith("⚠ "));

test("a placement's error draws its ⚠ cell, reaches the ⚠ list in full, and is noted once in the turn record", async () => {
  const r = rendererOf();
  const context = contextOf("s1");
  const session = context.hookData.session_id;
  answered(await handIn(r, { kind: "start", viewers: {}, sessions: [] }));
  answered(
    await handIn(r, {
      kind: "context",
      context,
      worldState: worldStateOf(session),
    }),
  );
  answered(
    await handIn(r, {
      kind: "config",
      origin: context.requested,
      config: snapshotOf(CONFIG),
    }),
  );
  let id = 0;
  const request = async () =>
    answered(
      await handIn(r, { kind: "request", id: ++id as RequestId, context }),
    );

  const first = await request();
  expect(textOf(presentOf(first.effects).frame)).toContain(`⚠ broken:`);
  expect(readFaults(noted(first, "faults"))).toContainEqual({
    level: "warning",
    kind: "segment",
    subject: "broken",
    message: MESSAGE,
  });
  expect(noted(first, "warn")).toContain("segment:broken");
  // A config naming no preset draws the floor, and the record says which.
  expect(noted(first, "preset")).toBe(PRESET_FLOOR);

  // Nothing moved: the record says so, and the bar's list, which follows
  // the frames, now counts the warning.
  const second = await request();
  expect(noted(second, "faults")).toBe("kept");
  const indicator = indicatorOf(presentOf(second.effects).frame);
  expect(indicator?.text).toBe("⚠ 1");

  // The indicator's click opens the viewer, which shows the whole message.
  const { verb, value } = clickOf(indicator!.url);
  answered(
    await handIn(r, {
      kind: "click",
      verb,
      value,
      session: { ok: true, id: session },
      arrival: { via: "link", delivery: { kind: "cli" } },
      context: { session, durable: { origin: context.requested }, live: context },
    }),
  );
  const viewed = textOf(presentOf((await request()).effects).frame);
  expect(viewed).toContain("[1/1]");
  expect(viewed).not.toContain("⚠ broken:");
  expect(viewed).toContain(`⚠ ${MESSAGE}`);
});
