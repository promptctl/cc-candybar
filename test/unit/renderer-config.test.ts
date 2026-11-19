// The main renderer draws from the config snapshots its host hands in and
// nothing else: every layer here names a file that does not exist, and the
// unit project refuses any read outside the package, so a renderer that opened
// a config, plugin or `.git` file would fail at that call. Built as the
// renderer's process builds it, from boot data.

import { TEST_ENV } from "../helpers/session-environment";
import { applyChanges } from "../../src/config/config-changes";
import type { ConfigSnapshot } from "../../src/config/config-snapshot";
import type { RenderOrigin } from "../../src/config-hint";
import { effectsOf, linksOf } from "../../src/click/read";
import { admitClick, encodeSegments, VERB_SET_CONFIG } from "../../src/click/wire";
import { DOOR_GLYPH } from "../../src/config/disclosure";
import { parseJson5Syntax } from "../../src/config/loader/diagnostics";
import { parseClick } from "../../src/daemon/click-reading";
import { FACTS_VERSION } from "../../src/daemon/facts-assembly";
import { publishingFrames } from "../../src/daemon/foundations/frame-publication";
import { PROTOCOL_VERSION } from "../../src/daemon/foundations/protocol";
import { MAIN_RENDERER } from "../../src/daemon/foundations/renderer-name";
import {
  sessionIdOf,
  type SessionId,
} from "../../src/daemon/foundations/session-id";
import { checkRenderRequest } from "../../src/daemon/render-checkpoint";
import type { WorldState } from "../../src/facts/world-state";
import { parseFrame, textOf, type Frame } from "../../src/render/frame";
import { timed } from "../../src/renderer-interface/interface";
import type {
  Effect,
  EffectId,
  Event,
  Present,
  Renderer,
  RendererBoot,
  RendererConstruction,
  RendererDiagnostics,
  RendererOutput,
  RequestId,
} from "../../src/renderer-interface/interface";
import type { CheckedRenderRequest } from "../../src/renderer-interface/request-context";
import { mainRendererOf } from "../../src/renderer/main";
import { EMPTY_STORED_STATE } from "../../src/renderer-interface/stored-state";
import {
  lineSplitter,
  rendererBootFrom,
  rendererOverLines,
  RENDERER_WIRE_VERSION,
  serveRenderer,
  type HostLine,
  type RendererLine,
} from "../../src/renderer-interface/wire";
import { listResolvablePaletteNames } from "../../src/themes/policy";
import { instantOf, readingsAt, type Tick } from "../../src/utils/instant";
import { ABSENT } from "../../src/utils/outcome";
import { daemonFactsOf } from "../helpers/daemon-facts";
import { TEST_SIGNER } from "../helpers/link-signer";
import { heldClock } from "../helpers/held-clock";
import {
  oversizedRendererHistory,
  oversizedSession,
} from "../helpers/oversized-renderer-history";
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

const bootOf = (stored = EMPTY_STORED_STATE): RendererBoot => ({
  stored,
  locations: {
    home: "/nowhere/home",
    configHome: "/nowhere/config",
    dataHome: "/nowhere/data",
    dataDirs: [],
  },
  memoryLimitBytes: 1024 * 1024 * 1024,
});

function renderer(boot = bootOf()): Renderer {
  const built = mainRendererOf(boot);
  if (built.kind === "refused") throw new Error(built.failure.detail);
  return built.renderer;
}

// [LAW:effects-at-boundaries] Only the pipes are in memory. Both passes use the
// process's boot parser, framing, transport and renderer. A fixed transport
// clock leaves every answer comparable, including the transport's timing field.
const lineBytes = (line: HostLine | RendererLine): string =>
  `${JSON.stringify(line)}\n`;

// [LAW:types-are-the-program] The core's construction outcome can be compared
// as data. The spawned-process handshake tests cover the process-ready envelope.
type CoreConstruction =
  | Omit<Extract<RendererConstruction, { kind: "built" }>, "renderer">
  | Extract<RendererConstruction, { kind: "refused" }>;

function rendererLines(send: (bytes: string) => void) {
  const construction = Promise.withResolvers<CoreConstruction>();
  let heard = (raw: string): void => {
    try {
      const built = mainRendererOf(rendererBootFrom(JSON.parse(raw)));
      if (built.kind === "refused") {
        construction.resolve(built);
        return;
      }
      const { renderer: core, ...outcome } = built;
      const receive = serveRenderer({
        renderer: timed(core, () => 0),
        send: (line) => send(lineBytes(line)),
        memory: () => {
          throw new Error("replay unexpectedly inspected process memory");
        },
        heapSnapshot: async () => {
          throw new Error("replay unexpectedly inspected the heap");
        },
      });
      heard = (line) => receive(JSON.parse(line) as HostLine);
      construction.resolve(outcome);
    } catch (error) {
      construction.reject(error);
    }
  };
  const lines = lineSplitter((line) => heard(line));
  // [LAW:no-ambient-temporal-coupling] A worker handles a pipe message in its
  // own turn. Failure stacks must have the same worker callers on both passes.
  return {
    construction: construction.promise,
    take: (bytes: string) => queueMicrotask(() => lines.push(bytes)),
  };
}

// [LAW:behavior-not-structure] Keep the exact JSON boot input and turn lines,
// including subscription deltas, before decoding. Compare the renderer's core
// construction result separately from the turn lines.
async function recordedRenderer(boot: RendererBoot) {
  const inputs: string[] = [];
  const outputs: string[] = [];
  const child = rendererLines((bytes) => {
    outputs.push(bytes);
    queueMicrotask(() => receive.push(bytes));
  });
  const send = (line: HostLine) => {
    const bytes = lineBytes(line);
    inputs.push(bytes);
    child.take(bytes);
  };
  const host = rendererOverLines({
    send,
    fault: (reason) => {
      throw new Error(reason);
    },
  });
  const receive = lineSplitter((line) =>
    host.heard(JSON.parse(line) as RendererLine),
  );
  send({ kind: "boot", wireVersion: RENDERER_WIRE_VERSION, boot });
  return {
    construction: await child.construction,
    inputs,
    outputs,
    renderer: host.renderer,
  };
}

async function replayLines(inputs: readonly string[]) {
  const [boot, ...turns] = inputs;
  if (boot === undefined) throw new Error("the capture has no boot line");
  const outputs: string[] = [];
  let pending: (() => void) | null = null;
  const child = rendererLines((bytes) => {
    outputs.push(bytes);
    if (pending === null) throw new Error("replay received an unsolicited reply");
    const complete = pending;
    pending = null;
    complete();
  });
  child.take(boot);
  const construction = await child.construction;
  if (construction.kind === "refused") return { construction, outputs };
  for (const bytes of turns)
    await new Promise<void>((resolve) => {
      pending = resolve;
      child.take(bytes);
    });
  return { construction, outputs };
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

const configLoads = ({ diagnostics }: RendererDiagnostics): string[] =>
  (diagnostics ?? []).flatMap(({ level, line }) =>
    level === "info" && line.startsWith("config loaded ") ? [line] : [],
  );

// A started renderer with the session's context in and its origin's config
// handed in as `text`, then a request of it answered: the bar drawn.
async function drawn(text: string) {
  const t = renderer();
  const context = contextOf("s1");
  const origin: RenderOrigin = context.requested;
  answered(await handIn(t, { kind: "start", viewers: {}, sessions: [], configs: [] }));
  const named = answered(
    await handIn(t, {
      kind: "context",
      context,
      worldState: worldStateOf(context.hookData.session_id),
    }),
  );
  const config = (text: string) =>
    handIn(t, { kind: "config", origin, config: snapshotOf(text) });
  const opened = answered(await config(text));
  const request = answered(
    await handIn(t, {
      kind: "request",
      id: 1 as RequestId,
      context,
    }),
  );
  return {
    opened,
    named,
    config,
    bar: textOf(presentOf(request.effects).frame),
    frame: presentOf(request.effects).frame,
  };
}

test("a session's bar draws from the layer text its origin's snapshot carries", async () => {
  const { named, bar, frame, opened } = await drawn(CONFIG);
  // The context waited for its origin, and its output named it.
  expect(named.subscriptions.configs).toHaveLength(1);
  expect(bar).toContain(SAID);
  expect(indicatorOf(frame)).toBeUndefined();
  // The one load is the view's opening, from the layer the snapshot carries.
  expect(configLoads(opened)).toEqual([
    expect.stringContaining(`cause=open state=built files=${USER_FILE} `),
  ]);
});

test("a fresh renderer reproduces the captured production-wire replies", async () => {
  const session = sessionIdOf("replay");
  const context = contextOf(session);
  const origin = context.requested;
  const palette = [...listResolvablePaletteNames()][0]!;
  const profile = "captured at construction";
  const live = await recordedRenderer(bootOf({
    ...oversizedRendererHistory(),
    sessions: { [session]: { remembered: profile } },
  }));
  const bootDiagnostic = {
    level: "info",
    line: `settings-history: trimmed an old step for session ${oversizedSession}`,
  };
  expect(live.construction).toEqual({
    kind: "built",
    diagnostics: [bootDiagnostic],
  });
  const config = JSON.stringify({
    globals: { experimentalPane: true },
    actions: {
      pal: { persist: "palette", from: "themes" },
      remember: { set: "remembered", to: "remembered by click" },
    },
    variables: { remembered: { kind: "state", key: "remembered", default: "missing" } },
    segments: {
      said: { template: `${SAID} {{ .remembered }} {{ frames 1 "phase-a" 1 "phase-b" }} {{ action "pal" "palette" "${palette}" }} {{ action "remember" "remember" }}` },
    },
    root: { h: ["said"] },
  });
  const clock = heldClock(new Date(1_700_000_000_000));
  const turn = (event: Event, afterMs: number) => {
    clock.advance(afterMs);
    return live.renderer.answer({
      kind: "event",
      ...readingsAt(clock),
      event,
    });
  };
  const started = answered(await turn(
    {
      kind: "start",
      viewers: {},
      sessions: [{ context, worldState: worldStateOf(session) }],
      configs: [{ origin, config: snapshotOf(config) }],
    },
    0,
  ));
  expect(configLoads(started)).toEqual([
    expect.stringContaining("cause=open state=built"),
  ]);
  expect(started.subscriptions.configs).toEqual([origin]);
  expect(started.subscriptions.lanes[session]?.pane).toBe(true);
  expect(started.stored).toContainEqual({
    store: "settings-history",
    key: oversizedSession,
    value: null,
  });
  expect(started.diagnostics).not.toContainEqual(bootDiagnostic);
  const first = presentOf(answered(await turn(
    { kind: "request", id: 1 as RequestId, context },
    10,
  )).effects);
  const published = publishingFrames(TEST_SIGNER)(first.frame, {
    renderer: MAIN_RENDERER,
    session,
  });
  expect(textOf(published)).toContain(`${SAID} ${profile}`);
  const click = (label: string) => {
    const link = linksOf(published).find(({ text }) => text === label);
    if (link === undefined) throw new Error(`frame drew no ${label} link`);
    const admitted = parseClick(link.url, { kind: "cli" }, TEST_SIGNER);
    if (admitted.kind === "refused") throw new Error(admitted.problem);
    return { link, admitted };
  };
  const acknowledge = (of: EffectId) =>
    turn({ kind: "effect-done", session, of, outcome: { kind: "ok" } }, 0);
  answered(await acknowledge(first.id));
  const sendClick = ({ admitted }: ReturnType<typeof click>) =>
    turn(
      {
        kind: "click",
        click: admitted.click,
        arrival: { via: "link", delivery: admitted.delivery },
        context: { session, durable: { origin }, live: null },
      },
      10,
    );
  const selection = click("palette");
  expect(effectsOf(selection.link.url)).toContainEqual({
    verb: VERB_SET_CONFIG, args: [session, "user", "palette", palette],
  });
  const changed = answered(await sendClick(selection)).effects.find(
    (effect) => effect.kind === "change",
  );
  if (changed === undefined)
    throw new Error("palette click returned no config change");
  expect(changed.target).toEqual({ kind: "layer", origin, role: "user" });
  const applied = applyChanges(config, changed.changes);
  if (applied.kind !== "applied" || applied.text === null)
    throw new Error("the captured palette change did not apply to its config");
  expect(parseJson5Syntax(applied.text)).toMatchObject({
    kind: "parsed",
    value: { globals: { palette } },
  });
  answered(await turn({ kind: "config", origin, config: snapshotOf(applied.text) }, 0));
  answered(await acknowledge(changed.id));
  const remembered = answered(await sendClick(click("remember")));
  expect(remembered.stored).toContainEqual({
    store: "session-state",
    key: session,
    value: { remembered: "remembered by click" },
  });
  const watching = answered(await turn({
    kind: "viewers",
    viewers: {
      [session]: {
        lanes: { pane: { subscribers: 1, drawing: true } },
        shown: true,
        joined: 1,
      },
    },
  }, 0));
  const due = async (wake: Tick | null) => {
    if (wake === null) throw new Error("the pane requested no scheduled draw");
    const delayMs = Math.max(0, Math.ceil(1000 * (wake - readingsAt(clock).tick)));
    const result = answered(await turn({ kind: "due" }, delayMs));
    const pushed = result.frames.find((each) => each.session === session)?.frame;
    if (pushed?.kind !== "drawn") throw new Error("scheduled pane drew no frame");
    const ack = answered(await acknowledge(pushed.receipt));
    return { frame: parseFrame(pushed.bar), wake: ack.wake };
  };
  const initialPane = await due(watching.wake);
  expect(initialPane.frame.motion).toBe("moves");
  expect(textOf(initialPane.frame)).toContain("remembered by click phase-a");
  const animatedPane = await due(initialPane.wake);
  expect(textOf(animatedPane.frame)).toContain("remembered by click phase-b");
  answered(await turn({ kind: "viewers", viewers: {} }, 0));

  const missingContext = contextOf("missing-from-capture");
  const failed = await turn(
    { kind: "request", id: 2 as RequestId, context: missingContext },
    100,
  );
  expect(failed).toMatchObject({
    kind: "threw",
    failure: { message: expect.stringContaining("missing-from-capture") },
  });
  const reloaded = answered(await turn(
    {
      kind: "config",
      origin,
      config: snapshotOf(applied.text.replace(SAID, "after replayed reload")),
    },
    100,
  ));
  expect(configLoads(reloaded)).toEqual([expect.stringContaining("cause=config state=built")]);
  const last = answered(await turn(
    { kind: "request", id: 3 as RequestId, context },
    100,
  ));
  expect(textOf(presentOf(last.effects).frame)).toContain(
    "after replayed reload",
  );

  expect(await replayLines(live.inputs)).toEqual({
    construction: live.construction,
    outputs: live.outputs,
  });
});

test("a snapshot whose layer will not parse draws the bundled bar, with its error on the indicator", async () => {
  const { bar, frame } = await drawn(`{ root: { h: ["said"] `);
  expect(bar).not.toContain(SAID);
  expect(bar).toContain(DOOR_GLYPH);
  expect(indicatorOf(frame)).toBe("⚠ 1");
});

test("a config turn with an equal snapshot loads nothing again", async () => {
  const { config } = await drawn(CONFIG);
  expect(configLoads(answered(await config(CONFIG)))).toEqual([]);
});

test("a config turn whose text moved only by a comment keeps the state it serves", async () => {
  const { config } = await drawn(CONFIG);
  expect(configLoads(answered(await config(`// a note\n${CONFIG}`)))).toEqual([
    expect.stringContaining("cause=config state=kept"),
  ]);
});

test("a click on a session with no live context waits for the config of the origin the host's book holds, and runs in that config's turn", async () => {
  const session = sessionIdOf("idle-one");
  const origin = contextOf("idle-one").requested;
  const r = renderer();
  answered(await handIn(r, { kind: "start", viewers: {}, sessions: [], configs: [] }));
  const palette = [...listResolvablePaletteNames()][0]!;
  const parked = answered(
    await handIn(r, {
      kind: "click",
      click: admitClick(VERB_SET_CONFIG, encodeSegments([session, "user", "palette", palette]), TEST_SIGNER).click,
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
