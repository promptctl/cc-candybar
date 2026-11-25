// The main renderer as its host drives it, in process over in-memory storage:
// built from boot data, handed a session's context, world state and config
// snapshot, and read back from its answers. Every layer names a file that does
// not exist, so a renderer that read one would fail at that call.

import { TEST_ENV } from "./session-environment";
import { linksOf } from "../../src/click/read";
import type { ConfigSnapshot } from "../../src/config/config-snapshot";
import { FACTS_VERSION } from "../../src/daemon/facts-assembly";
import { PROTOCOL_VERSION } from "../../src/daemon/foundations/protocol";
import type { SessionId } from "../../src/daemon/foundations/session-id";
import { checkRenderRequest } from "../../src/daemon/render-checkpoint";
import type { WorldState } from "../../src/facts/world-state";
import type { Frame } from "../../src/render/frame";
import type {
  Effect,
  Event,
  Present,
  Renderer,
  RendererBoot,
  RendererOutput,
} from "../../src/renderer-interface/interface";
import type { CheckedRenderRequest } from "../../src/renderer-interface/request-context";
import { EMPTY_STORED_STATE } from "../../src/renderer-interface/stored-state";
import { mainRendererOf } from "../../src/renderer/main";
import { instantOf, type Tick } from "../../src/utils/instant";
import { ABSENT } from "../../src/utils/outcome";
import { daemonFactsOf } from "../../scripts/lib/draw-fixtures/daemon-facts";
import { viewFacts } from "../../scripts/lib/draw-fixtures/view-facts";

export const AT = instantOf(new Date(1_700_000_000_000));
export const READ = { at: AT, tick: 0 as Tick };
export const PROJECT = "/nowhere/project";
export const USER_FILE = "/nowhere/config/cc-candybar/config.json5";

export const bootOf = (stored = EMPTY_STORED_STATE): RendererBoot => ({
  stored,
  locations: {
    home: "/nowhere/home",
    configHome: "/nowhere/config",
    dataHome: "/nowhere/data",
    dataDirs: [],
  },
  region: { locale: "en-US", timeZone: "UTC" },
  memoryLimitBytes: 1024 * 1024 * 1024,
});

export function rendererOf(boot = bootOf()): Renderer {
  const built = mainRendererOf(boot);
  if (built.kind === "refused") throw new Error(built.failure.detail);
  return built.renderer;
}

// A statusline request of `session` in the project, across the host's
// checkpoint.
export function contextOf(session: string): CheckedRenderRequest {
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
export function worldStateOf(session: SessionId): WorldState {
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
export const snapshotOf = (text: string): ConfigSnapshot => ({
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

export const handIn = (r: Renderer, event: Event): Promise<RendererOutput> =>
  r.answer({ kind: "event", ...READ, event });

export const answered = (output: RendererOutput) => {
  if (output.kind !== "answered")
    throw new Error(`the turn threw: ${output.failure.detail}`);
  return output;
};

export const presentOf = (effects: readonly Effect[]): Present => {
  const present = effects.find((e): e is Present => e.kind === "present");
  if (present === undefined) throw new Error("no present among the effects");
  return present;
};

// The bar's indicator: the link wearing the error glyph.
export const indicatorOf = (frame: Pick<Frame, "rows">) =>
  linksOf(frame).find(({ text }) => text.startsWith("⚠ "));
