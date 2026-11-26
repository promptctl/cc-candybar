import type {
  ConfigSnapshot,
  PluginFile,
} from "../../src/config/config-snapshot";
import {
  CLICK_MODE_KEY,
  HOVER_KEY,
  NO_HOVER,
} from "../../src/config/click-mode";
import { DISCLOSURE_OPEN } from "../../src/config/disclosure";
import { SETTINGS_ANCHOR } from "../../src/config/door";
import {
  admitClick,
  encodeSegments,
  VERB_SET_STATE,
} from "../../src/click/wire";
import { assembleFacts } from "../../src/daemon/facts-assembly";
import { environmentOutput } from "../../src/daemon/environment-output";
import {
  PROTOCOL_VERSION,
  type ReaderRenderRequest,
} from "../../src/daemon/foundations/protocol";
import { variableOf } from "../../src/daemon/foundations/session-env";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { checkRenderRequest } from "../../src/daemon/render-checkpoint";
import {
  SESSION_STATE_FILE,
  sessionsOf,
} from "../../src/daemon/session-state-file";
import type { RunReading } from "../../src/daemon/readings";
import {
  recordingBootProblem,
  recordingInputProblem,
  recordingOutputProblem,
} from "../../src/daemon/recording-privacy";
import type { WorldState } from "../../src/facts/world-state";
import { parseFrame, textOf } from "../../src/render/frame";
import {
  type EffectId,
  type Event,
  type EventInput,
  type RendererBoot,
  type RequestId,
} from "../../src/renderer-interface/interface";
import { heardContextOf } from "../../src/renderer-interface/request-context";
import { EMPTY_STORED_STATE } from "../../src/renderer-interface/stored-state";
import { mainRendererOf } from "../../src/renderer/main";
import { instantOf, type Tick } from "../../src/utils/instant";
import { ABSENT, failed, ok } from "../../src/utils/outcome";
import { pending, type Current } from "../../src/utils/reading";
import { daemonFactsOf } from "../../scripts/lib/draw-fixtures/daemon-facts";
import { TEST_SIGNER } from "../helpers/link-signer";
import { viewFacts } from "../../scripts/lib/draw-fixtures/view-facts";

const SESSION = sessionIdOf("recording-privacy");
const ROOT = "/nowhere/project";
const HOOK = viewFacts(ROOT, SESSION).hookData;
const AT = instantOf(new Date(1_700_000_000_000));
const BOOT: RendererBoot = {
  stored: EMPTY_STORED_STATE,
  locations: {
    home: "/nowhere/home",
    configHome: "/nowhere/config",
    dataHome: "/nowhere/data",
    dataDirs: [],
  },
  region: { locale: "en-US", timeZone: "UTC" },
  memoryLimitBytes: 1024 * 1024 * 1024,
};
const SELECTED = "CANDYBAR_CAPTURE_SELECTED";
const UNREQUESTED = "capture-private-unrequested-value";
const SECRET = "capture-private-selected-value";
const ACTION_SECRET = "capture-private-action-value";
const ACTION_CONFIG = `{
  actions: { task: { run: ["echo"], env: { EXAMPLE: "${ACTION_SECRET}" } } },
  segments: { task: { template: '{{ action "task" "run" }}' } },
  root: { h: ["task"] },
}`;
const ENV_CONFIG = `{
  variables: { selected: { kind: "env", name: "${SELECTED}" } },
  segments: { value: { template: "{{ .selected }}" } },
  root: { h: ["value"] },
}`;

function checked(input: Partial<ReaderRenderRequest> = {}) {
  const result = checkRenderRequest(
    {
      v: PROTOCOL_VERSION,
      kind: "render",
      cwd: ROOT,
      args: ["cc-candybar"],
      hookData: HOOK,
      env: {
        PATH: "/usr/bin",
        OTHER_VARIABLE: UNREQUESTED,
        [SELECTED]: SECRET,
      },
      terminalEnv: { TERM: "xterm" },
      ...input,
    },
    { firstSightOfUnknownHookField: () => false },
    () => {},
    BOOT.locations.home,
  );
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result;
}

function facts(
  env: ReadonlyMap<string, Current<string>> = new Map(),
  runs: ReadonlyMap<string, RunReading> = new Map(),
  prior?: WorldState,
): WorldState {
  return assembleFacts(
    prior,
    SESSION,
    {
      lanes: {
        usage: ABSENT,
        speed: ABSENT,
        context: ABSENT,
        metrics: ABSENT,
        activity: ABSENT,
        cache: ABSENT,
        autoCompact: ABSENT,
        git: ABSENT,
        tmuxSession: ABSENT,
        hostName: ABSENT,
        hostUser: ABSENT,
        sources: new Map(),
        runs,
        env,
      },
      today: ABSENT,
      losses: [],
    },
    daemonFactsOf(),
    AT,
  );
}

function snapshot(text: string): ConfigSnapshot {
  return {
    chain: [
      {
        role: "user",
        path: "/nowhere/config/candybar.json5",
        content: { kind: "text", text },
        listed: {},
      },
    ],
    repo: null,
    checkout: { root: ROOT, git: false },
    plugins: [],
    strays: [],
    notices: [],
    watch: null,
  };
}

const input = (event: Event): EventInput => ({
  kind: "event",
  event,
  at: AT,
  tick: 0 as Tick,
});

async function draw(text: string, worldState = facts()) {
  const context = checked().req;
  const start = input({
    kind: "start",
    viewers: {},
    sessions: [{ context, worldState }],
    configs: [{ origin: context.requested, config: snapshot(text) }],
  });
  const built = mainRendererOf(BOOT);
  if (built.kind === "refused") throw new Error(built.failure.detail);
  const started = await built.renderer.answer(start);
  if (started.kind === "threw") throw new Error(started.failure.detail);
  const request = input({ kind: "request", id: 1 as RequestId, context });
  const output = await built.renderer.answer(request);
  if (output.kind === "threw") throw new Error(output.failure.detail);
  const present = output.effects.find((effect) => effect.kind === "present");
  if (present === undefined)
    throw new Error("the request did not draw a frame");
  return { start, request, output, present };
}

test("the ordinary capture retains parsed client facts and drops all unrequested environment values", async () => {
  const { start, request, output, present } = await draw(
    '{ segments: { sent: { template: "ordinary capture" } }, root: { h: ["sent"] } }',
  );
  expect(textOf(parseFrame(present.frame))).toContain("ordinary capture");
  expect(recordingBootProblem(BOOT)).toBeNull();
  expect(recordingInputProblem(start)).toBeNull();
  expect(recordingInputProblem(request)).toBeNull();
  expect(recordingOutputProblem(output)).toBeNull();
  const bytes = JSON.stringify({ boot: BOOT, start, request, output });
  expect(bytes).toContain("xterm");
  expect(bytes).not.toContain(UNREQUESTED);
  expect(bytes).not.toContain(SECRET);
  expect(bytes).not.toContain('"OTHER_VARIABLE"');
});

test("a selected environment value that the real renderer echoes disqualifies its containing input", async () => {
  const { req, environment } = checked();
  if (environment.kind !== "ok") throw new Error(environment.reason);
  const value = variableOf(environment.value, SELECTED);
  const worldState = facts(new Map([[SELECTED, value]]));
  const { start, output, present } = await draw(ENV_CONFIG, worldState);
  expect(textOf(parseFrame(present.frame))).toContain(SECRET);
  expect(JSON.stringify(output)).toContain(SECRET);
  for (const event of [
    start,
    input({ kind: "context", context: req, worldState }),
    input({ kind: "world-state", worldState }),
  ]) {
    const problem = recordingInputProblem(event);
    expect(problem).toMatch(/environment source supplied a value/);
    expect(problem).not.toContain(SECRET);
  }
});

test("an environment declaration without a value is recordable, including absent, pending and failed facts", () => {
  const context = checked().req;
  for (const reading of [
    ABSENT,
    pending("unread"),
    failed("not reported", "read"),
  ]) {
    const worldState = facts(new Map([[SELECTED, reading]]));
    expect(
      recordingInputProblem(
        input({
          kind: "start",
          sessions: [{ context, worldState }],
          configs: [
            { origin: context.requested, config: snapshot(ENV_CONFIG) },
          ],
          viewers: {},
        }),
      ),
    ).toBeNull();
  }
  const blank = facts(
    new Map([[SELECTED, variableOf({ [SELECTED]: "" }, SELECTED)]]),
  );
  expect(
    recordingInputProblem(input({ kind: "world-state", worldState: blank })),
  ).toMatch(/environment source supplied a value/);
});

test("equal shell output keeps its wire bytes when newly bound environment makes it private", () => {
  const observation = { reading: ok("same output"), fault: null };
  const clean = facts(undefined, new Map([["run", observation]]));
  const inherited = environmentOutput(observation, true);
  const tainted = facts(undefined, new Map([["run", inherited]]), clean);
  expect(
    recordingInputProblem(input({ kind: "world-state", worldState: clean })),
  ).toBeNull();
  expect(
    recordingInputProblem(input({ kind: "world-state", worldState: tainted })),
  ).toMatch(/command returned data after receiving a session environment/);
  expect(JSON.stringify(tainted.runs)).toBe(JSON.stringify(clean.runs));
  expect(facts(undefined, new Map([["run", inherited]]), tainted)).toBe(
    tainted,
  );
});

test("a daemon task's throw refuses the capture while every bar holds it, and allows it once it has left", () => {
  const thrown = environmentOutput(
    {
      text: "session sweep threw: it broke",
      at: AT,
      revision: 1,
      answered: false,
    },
    true,
  );
  const clean = facts();
  const held = {
    ...clean,
    daemon: {
      ...clean.daemon,
      held: [
        { kind: "task-threw" as const, about: "session sweep", event: thrown },
      ],
    },
  };
  expect(
    recordingInputProblem(input({ kind: "world-state", worldState: held })),
  ).toMatch(/command returned data after receiving a session environment/);
  expect(
    recordingInputProblem(input({ kind: "world-state", worldState: clean })),
  ).toBeNull();
});

test("capture refuses raw hook extensions and the raw hint payload the renderer receives for diagnostics", () => {
  const top = { ...HOOK, clientExtension: { EXAMPLE: UNREQUESTED } };
  const nested = {
    ...HOOK,
    workspace: { ...HOOK.workspace, environment: { EXAMPLE: UNREQUESTED } },
  };
  const malformed = JSON.parse(
    JSON.stringify({ TERM: 13, EXAMPLE: UNREQUESTED }),
  );
  const click = admitClick(
    VERB_SET_STATE,
    encodeSegments([SESSION, "example", "value"]),
    TEST_SIGNER,
  ).click;
  for (const { req } of [
    checked({ hookData: top }),
    checked({ hookData: nested }),
    checked({ terminalEnv: malformed }),
  ]) {
    const asRequest = input({
      kind: "request",
      id: 1 as RequestId,
      context: req,
    });
    const asClick = input({
      kind: "click",
      click,
      context: heardContextOf(req),
    });
    expect(JSON.stringify(asRequest)).toContain(UNREQUESTED);
    for (const event of [asRequest, asClick]) {
      const problem = recordingInputProblem(event);
      expect(problem).toMatch(/client (hook|supplied unparsed hints)/);
      expect(problem).not.toContain(UNREQUESTED);
    }
  }
});

test("action overlays are refused before raw layer, plugin or retained config bytes can be exported", () => {
  const origin = checked().req.requested;
  const safe = snapshot("{}");
  const plugin: PluginFile = {
    scope: "plugins",
    path: "/nowhere/plugin/plugin.json5",
    definition: {
      kind: "text",
      text: `{ actions: { task: { run: ["echo"], env: { EXAMPLE: "${ACTION_SECRET}" } } } }`,
      dir: "/nowhere/plugin",
      storage: "/nowhere/data/plugin",
    },
  };
  for (const event of [
    input({ kind: "config", origin, config: snapshot(ACTION_CONFIG) }),
    input({ kind: "config", origin, config: { ...safe, plugins: [plugin] } }),
    input({
      kind: "config",
      origin,
      config: {
        ...safe,
        chain: safe.chain.map((layer) => ({
          ...layer,
          listed: { "../plugin": plugin },
        })),
      },
    }),
    input({
      kind: "start",
      sessions: [],
      viewers: {},
      configs: [{ origin, config: safe, retained: snapshot(ACTION_CONFIG) }],
    }),
  ]) {
    const problem = recordingInputProblem(event);
    expect(problem).toMatch(/run action supplies environment/);
    expect(problem).not.toContain(ACTION_SECRET);
  }
  expect(
    recordingInputProblem(
      input({
        kind: "config",
        origin,
        config: snapshot(
          ACTION_CONFIG.replace(`EXAMPLE: "${ACTION_SECRET}"`, ""),
        ),
      }),
    ),
  ).toBeNull();
});

test("raw malformed and duplicate-key config bytes have unknown eligibility", () => {
  const origin = checked().req.requested;
  for (const text of [
    `{ actions: { task: { run: ["echo"], env: { EXAMPLE: "${ACTION_SECRET}"`,
    `{ actions: { task: { run: ["echo"], env: { EXAMPLE: "${ACTION_SECRET}" }, env: {} } } }`,
  ]) {
    const event = input({ kind: "config", origin, config: snapshot(text) });
    const problem = recordingInputProblem(event);
    expect(problem).toMatch(/could not be inspected/);
    expect(problem).not.toContain(ACTION_SECRET);
  }
});

test("the output check sees the evaluated run environment in ordinary and pane frame data", async () => {
  const { output, present } = await draw(ACTION_CONFIG);
  expect(textOf(parseFrame(present.frame))).toContain("run");
  expect(JSON.stringify(output)).toContain(ACTION_SECRET);
  expect(recordingOutputProblem(output)).toMatch(
    /run action supplies environment/,
  );
  const pane = {
    session: SESSION,
    frame: {
      kind: "drawn" as const,
      receipt: 1 as EffectId,
      bar: present.frame,
      handoff: null,
    },
  };
  const plain = { ...present.frame, rows: [] };
  for (const pushed of [
    pane,
    { ...pane, frame: { ...pane.frame, bar: plain, handoff: present.frame } },
  ]) {
    const problem = recordingOutputProblem({
      ...output,
      effects: [],
      frames: [pushed],
    });
    expect(problem).toMatch(/run action supplies environment/);
    expect(problem).not.toContain(ACTION_SECRET);
  }
});

test("recording can start from a profile saved with the former layout and toggles menus open", () => {
  // The keys on disk in the release that offered these two menu members.
  const tab = "candybar.tab";
  const picker = "menus._candybarZ00002epickers";
  const fromDisk = (sessions: unknown) => {
    const parsed = sessionsOf(SESSION_STATE_FILE)(sessions);
    if (parsed.kind !== "ok") throw new Error(parsed.reason);
    const boot = {
      ...BOOT,
      stored: {
        sessions: Object.fromEntries(parsed.value.sessions),
        history: {},
      },
    };
    return { boot, dropped: parsed.value.dropped };
  };
  const old = {
    layout: { [tab]: "layout", padding: "2" },
    toggles: { [picker]: "toggles" },
    current: { [tab]: "config", [picker]: "renderer" },
  };
  const { boot, dropped } = fromDisk(old);
  expect(dropped).toEqual([
    { session: "layout", part: tab, why: expect.stringContaining('"layout"') },
    {
      session: "toggles",
      part: null,
      why: expect.stringContaining('"toggles"'),
    },
  ]);
  expect(recordingBootProblem(boot)).toBeNull();
  expect(boot.stored.sessions).toEqual({
    layout: { padding: "2" },
    current: old.current,
  });
  for (const privatePick of [
    { [tab]: SECRET },
    { [picker]: SECRET },
    { [tab]: "toggles" },
    { [picker]: "layout" },
    { authored: "layout" },
    { authored: "toggles" },
  ]) {
    expect(
      recordingBootProblem(fromDisk({ ...old, private: privatePick }).boot),
    ).toMatch(/saved renderer state contains values of unknown origin/);
  }
  expect(
    recordingBootProblem({
      ...boot,
      stored: {
        ...boot.stored,
        history: {
          [SESSION]: {
            past: [
              [{ kind: "session", key: "padding", before: SECRET, after: "2" }],
            ],
            future: [],
          },
        },
      },
    }),
  ).toMatch(/saved renderer state contains values of unknown origin/);
});

test("boot admits the click mode and refuses a hovered region's name", () => {
  const withPicks = (picks: Record<string, string>) => ({
    ...BOOT,
    stored: { sessions: { [SESSION]: picks }, history: {} },
  });
  expect(
    recordingBootProblem(
      withPicks({ [CLICK_MODE_KEY]: "alt", [HOVER_KEY]: NO_HOVER }),
    ),
  ).toBeNull();
  // A region's name is config text, which a recording must not carry.
  expect(recordingBootProblem(withPicks({ [HOVER_KEY]: SECRET }))).toMatch(
    /saved renderer state contains values of unknown origin/,
  );
});

test("boot preserves built-in state and layer history and refuses unsupported historical text", () => {
  const state = {
    ...BOOT,
    stored: {
      sessions: {
        [SESSION]: { [SETTINGS_ANCHOR]: DISCLOSURE_OPEN, padding: "2" },
      },
      history: {
        [SESSION]: {
          past: [
            [
              {
                kind: "session" as const,
                key: "padding",
                before: null,
                after: "2",
              },
            ],
          ],
          future: [
            [
              {
                kind: "layer" as const,
                role: "user" as const,
                digest: "same-layer",
                before: "{}",
                after: "{ globals: { padding: 2 } }",
              },
            ],
          ],
        },
      },
    },
  };
  const bytes = JSON.stringify(state);
  expect(recordingBootProblem(state)).toBeNull();
  expect(JSON.stringify(state)).toBe(bytes);
  expect(
    recordingBootProblem({
      ...state,
      stored: {
        ...state.stored,
        sessions: { [SESSION]: { "click.error": SECRET } },
      },
    }),
  ).toMatch(/saved renderer state contains values of unknown origin/);
  const oldLayer = recordingBootProblem({
    ...BOOT,
    stored: {
      sessions: {},
      history: {
        [SESSION]: {
          past: [],
          future: [
            [
              {
                kind: "layer",
                role: "user",
                digest: "same-layer",
                before: ACTION_CONFIG,
                after: "{}",
              },
            ],
          ],
        },
      },
    },
  });
  expect(oldLayer).toMatch(/run action supplies environment/);
  expect(oldLayer).not.toContain(ACTION_SECRET);
});
