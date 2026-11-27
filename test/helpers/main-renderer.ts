// The main renderer as its host drives it, in process over in-memory storage:
// built from boot data, handed a session's context, world state and config
// snapshot, and read back from its answers. Every layer names a file that does
// not exist, so a renderer that read one would fail at that call.

import { SAMPLE_REGION } from "../../scripts/lib/draw-fixtures/sample-region.js";
import type { ConfigSnapshot } from "../../src/config/config-snapshot";
import { FACTS_VERSION } from "../../src/daemon/facts-assembly";
import type { SessionId } from "../../src/daemon/foundations/session-id";
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
import type { Tick } from "../../src/utils/instant";
import { AT } from "./session-rig";
import { heardRequest } from "./click";
import { viewerLink } from "./diagnostics-viewer";
import { ABSENT } from "../../src/utils/outcome";
import { daemonFactsOf } from "../../scripts/lib/draw-fixtures/daemon-facts";

export { AT };
export const READ = { at: AT, tick: 0 as Tick };
export const PROJECT = "/nowhere/project";
export const USER_FILE = "/nowhere/config/cc-candybar/config.json5";

export const bootOf = (stored = EMPTY_STORED_STATE): RendererBoot => ({
  sessionRevision: 0,
  stored,
  locations: {
    home: "/nowhere/home",
    configHome: "/nowhere/config",
    dataHome: "/nowhere/data",
    dataDirs: [],
  },
  region: SAMPLE_REGION,
  memoryLimitBytes: 1024 * 1024 * 1024,
});

export function rendererOf(boot = bootOf()): Renderer {
  const built = mainRendererOf(boot);
  if (built.kind === "refused") throw new Error(built.failure.detail);
  return built.renderer;
}

// A statusline request of `session` in the project, across the host's
// checkpoint, asking for a frame.
export const contextOf = (session: string): CheckedRenderRequest =>
  heardRequest(session, PROJECT, { encoding: "frame" });

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
    stampFailure: null,
    transcriptLosses: [],
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

// A turn's one effect, its present.
export const presentOf = (effects: readonly Effect[]): Present => {
  if (effects.length !== 1)
    throw new Error(`the turn had ${effects.length} effects, not one present`);
  const [present] = effects;
  if (present?.kind !== "present") throw new Error("the turn presented nothing");
  return present;
};

// The bar's indicator: the link that opens the diagnostics viewer.
export const indicatorLinkOf = (frame: Pick<Frame, "rows">) =>
  viewerLink(frame, "open");
