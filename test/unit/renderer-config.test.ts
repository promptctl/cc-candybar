// The main renderer draws from the config snapshots its host hands in and
// nothing else: every layer here names a file that does not exist, and the
// unit project refuses any read outside the package, so a renderer that opened
// a config, plugin or `.git` file would fail at that call. Built as the
// renderer's process builds it (`loadMainRenderer`), over in-memory storage.

import { TEST_ENV } from "../helpers/session-environment";
import type { ConfigSnapshot } from "../../src/config/config-snapshot";
import type { RenderOrigin } from "../../src/config-hint";
import { linksOf } from "../../src/click/read";
import { encodeSegments, VERB_SET_CONFIG } from "../../src/click/wire";
import { DOOR_GLYPH } from "../../src/config/disclosure";
import { FACTS_VERSION } from "../../src/daemon/facts-assembly";
import { PROTOCOL_VERSION } from "../../src/daemon/foundations/protocol";
import {
  sessionIdOf,
  type SessionId,
} from "../../src/daemon/foundations/session-id";
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
import type { CheckedRenderRequest } from "../../src/renderer-interface/request-context";
import { mainRendererOf } from "../../src/renderer/main";
import { EMPTY_STORED_STATE } from "../../src/renderer-interface/stored-state";
import { listResolvablePaletteNames } from "../../src/themes/policy";
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
const SAID = "said-by-the-snapshot";
// The palette is a persisted setting, so a click may write it.
const CONFIG = `{
  actions: { pal: { persist: "palette", from: "themes" } },
  segments: { said: { template: "${SAID}" } },
  root: { h: ["said"] },
}`;

// The renderer built from a profile whose sessions hold `recorded`, and every
// line it hands the host's log.
function renderer(recorded: ReadonlyMap<SessionId, Record<string, string>>) {
  const logged: string[] = [];
  const r = mainRendererOf(
    {
      stored: { ...EMPTY_STORED_STATE, sessions: [...recorded] },
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
      log: (level, message) => void logged.push(`${level} ${message}`),
      eventAnswered: () => {},
      storage: NO_PLUGIN_STORAGE,
    },
  );
  return { r, logged };
}

// A statusline request of `session` in the project, across the host's
// checkpoint.
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

// What the host read for a session: nothing yet, of anything.
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

// What discovery would hand in for the user's file holding `text`.
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

// The bar's indicator: the link wearing the error glyph.
const indicatorOf = (frame: Pick<Frame, "rows">): string | undefined =>
  linksOf(frame).find(({ text }) => text.startsWith("⚠ "))?.text;

const configLoads = (logged: readonly string[]): string[] =>
  logged.filter((line) => line.startsWith("info config loaded "));

// A started renderer with the session's context in and its origin's config
// handed in as `text`, then a request of it answered: the bar drawn.
async function drawn(text: string) {
  const t = renderer(new Map());
  const context = contextOf("s1");
  const origin: RenderOrigin = context.requested;
  answered(await handIn(t.r, { kind: "start", viewers: {}, sessions: [] }));
  const named = answered(
    await handIn(t.r, {
      kind: "context",
      context,
      worldState: worldStateOf(context.hookData.session_id),
    }),
  );
  const config = (text: string) =>
    handIn(t.r, { kind: "config", origin, config: snapshotOf(text) });
  answered(await config(text));
  const request = answered(
    await handIn(t.r, {
      kind: "request",
      id: 1 as RequestId,
      context,
    }),
  );
  return {
    ...t,
    named,
    config,
    bar: textOf(presentOf(request.effects).frame),
    frame: presentOf(request.effects).frame,
  };
}

test("a session's bar draws from the layer text its origin's snapshot carries", async () => {
  const { named, bar, frame, logged } = await drawn(CONFIG);
  // The context waited for its origin, and its output named it.
  expect(named.subscriptions.configs).toHaveLength(1);
  expect(bar).toContain(SAID);
  expect(indicatorOf(frame)).toBeUndefined();
  // The one load is the view's opening, from the layer the snapshot carries.
  expect(configLoads(logged)).toEqual([
    expect.stringContaining(`cause=open state=built files=${USER_FILE} `),
  ]);
});

test("a snapshot whose layer will not parse draws the bundled bar, with its error on the indicator", async () => {
  const { bar, frame } = await drawn(`{ root: { h: ["said"] `);
  expect(bar).not.toContain(SAID);
  expect(bar).toContain(DOOR_GLYPH);
  expect(indicatorOf(frame)).toBe("⚠ 1");
});

test("a config turn with an equal snapshot loads nothing again", async () => {
  const { config, logged } = await drawn(CONFIG);
  const opened = configLoads(logged).length;
  answered(await config(CONFIG));
  expect(configLoads(logged).slice(opened)).toEqual([]);
});

test("a config turn whose text moved only by a comment keeps the state it serves", async () => {
  const { config, logged } = await drawn(CONFIG);
  const opened = configLoads(logged).length;
  answered(await config(`// a note\n${CONFIG}`));
  expect(configLoads(logged).slice(opened)).toEqual([
    expect.stringContaining("cause=config state=kept"),
  ]);
});

test("a click on a session with no live context waits for the config of the origin the host's book holds, and runs in that config's turn", async () => {
  const session = sessionIdOf("idle-one");
  const origin = contextOf("idle-one").requested;
  const { r } = renderer(new Map());
  answered(await handIn(r, { kind: "start", viewers: {}, sessions: [] }));
  const palette = [...listResolvablePaletteNames()][0]!;
  const parked = answered(
    await handIn(r, {
      kind: "click",
      verb: VERB_SET_CONFIG,
      value: encodeSegments([session, "user", "palette", palette]),
      session: { ok: true, id: session },
      arrival: { via: "link", delivery: { kind: "cli" } },
      // Read back from the book after a restart: no live part.
      context: { session, durable: { origin }, live: null },
    }),
  );
  expect(parked.effects).toEqual([]);
  expect(parked.record).toContainEqual(["parked", "click"]);
  expect(parked.subscriptions.configs).toEqual([origin]);
  const landed = answered(
    await handIn(r, { kind: "config", origin, config: snapshotOf(CONFIG) }),
  );
  expect(landed.effects).toEqual([
    expect.objectContaining({
      kind: "change",
      session,
      target: { kind: "layer", origin, role: "user" },
    }),
  ]);
});
