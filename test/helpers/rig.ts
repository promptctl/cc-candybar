// The rig a render test draws and clicks through: a config composed into a
// store and a registry, through the same registration used by the daemon.
// Every field has a default, so a test states only what it varies.
//
// [LAW:one-source-of-truth] This is the one assembly a test that draws and
// clicks is meant to share. A test file keeps its own vocabulary (which link to
// click, which cell to read), not its own copy of parse → store → registry →
// compile → draw.
//
// [LAW:decomposition] What a test shares and what it owns follow the daemon's
// split (src/dsl/render.ts registerCompiled): the parse of a source and its
// compile hold no store and no subscription, so rigs share them; the store,
// registry and session state hold subscriptions and session picks, so each
// `buildRig` makes its own, and a shared one would be a mutable fixture.
//
// Jest gives each test FILE its own module registry, so the sharing below spans
// the rigs one file builds, never two files.

import { DEFAULT_DSL_CONFIG } from "../../src/config/default-dsl-config";
import type { DslConfig, ValidatedConfig } from "../../src/config/dsl-types";
import {
  knownOptionDomainNames,
  resolveOptionDomain,
} from "../../src/config/option-domain";
import { SessionState } from "../../src/renderer/session-state";
import {
  compileDslConfig,
  registerCompiled,
  EVERY_SCOPE,
  type CompiledConfig,
  type CompileProvider,
  type DrawnFrame,
  type RegisteredConfig,
} from "../../src/dsl/render";
import type { SessionId } from "../../src/daemon/foundations/session-id";
import type { VerbContext } from "../../src/renderer/verbs";
import type { SettingsHistory } from "../../src/renderer/settings-history";
import type { SessionStateRW } from "../../src/renderer-interface/session-state";
import type { Host } from "../../src/host";
import type { BuildLineOptions } from "../../src/render/strip";
import { listResolvablePaletteNames } from "../../src/themes/policy";
import { instantOf, type Instant } from "../../src/utils/instant";
import { systemTimekeeper } from "./system-clock";
import { SourceRegistry } from "../../src/var-system/sources";
import { VariableStore } from "../../src/var-system/store";
import {
  bookedContext,
  clickUrl,
  recordRender,
  testVerbContext,
} from "./click";
import { readingsIn } from "./session-environment";
import { drawPayload } from "./draw-payload";
import { sessionOfPayload, TEST_SESSION } from "./payload-session";
import { unscriptedRuns } from "./fake-launcher";
import { EMPTY_DEFAULT, parseAndValidate } from "./parse-and-validate";
import { selectionFor, type RenderSelection } from "./selection";

export { DEFAULT_DSL_CONFIG, EMPTY_DEFAULT };

// The session a payload naming none draws, so such a payload draws the rig's own.
const SESSION_ID = TEST_SESSION;
const CWD = "/tmp/proj";
const ALL_PALETTES: ReadonlySet<string> = new Set(listResolvablePaletteNames());

/** The strip a test with no opinion on it draws: one row of unbounded width. */
export const RIG_OPTS: BuildLineOptions = {
  endcaps: "powerline",
  colorCompatibility: "truecolor",
  wrap: true,
  padding: 0,
  width: Number.POSITIVE_INFINITY,
};

export interface RigInit {
  /** The authored config, JSON5. Empty is a config that declares nothing. */
  readonly source?: string;
  /** The file name a parse failure names. */
  readonly label?: string;
  /** What `source` merges over: `EMPTY_DEFAULT` (its own slice alone) or `DEFAULT_DSL_CONFIG` (the production cascade). */
  readonly base?: DslConfig;
  readonly palettes?: ReadonlySet<string>;
  /**
   * The part of the parsed config the rig compiles and draws: the whole of it
   * unless a test narrows it (to one segment, say). The selection is still
   * resolved over the whole config, as the daemon resolves it.
   */
  readonly narrow?: (config: ValidatedConfig) => ValidatedConfig;
  /** The directory `shell` sources run in; the session's project directory. */
  readonly cwd?: string;
  /** The session's environment, which an `env` source reads; empty unless stated. */
  readonly env?: Readonly<Record<string, string>>;
  /** The session the rig draws and clicks as, and its state (a test sharing one across rigs hands it in). */
  readonly sessionId?: SessionId;
  readonly sessionState?: SessionState;
  /** What the click path is built with beyond the config: the history and host a durable-config test owns. */
  readonly history?: (sessionState: SessionStateRW) => SettingsHistory;
  readonly host?: Host;
}

export interface DrawInit {
  /** The payload, whole. Defaults to the session's id and project directory. */
  readonly payload?: object;
  readonly opts?: Partial<BuildLineOptions>;
  readonly at?: Instant;
  /** The selection, whole. Defaults to the daemon's resolution over the picks of the session the payload draws. */
  readonly selection?: RenderSelection;
}

/** A frame as the rig drew it, with the selection it was drawn under. */
export interface RigFrame extends DrawnFrame {
  readonly selection: RenderSelection;
}

export interface Rig {
  readonly config: ValidatedConfig;
  readonly compiled: RegisteredConfig;
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
  readonly sessionState: SessionState;
  readonly sessionId: SessionId;
  /** The context a click runs in: a test that overrides a field spreads it. */
  readonly ctx: VerbContext;
  /** The frame the session draws now. */
  draw(init?: DrawInit): RigFrame;
  /** One click, through the verb its URL names, as the daemon runs it. */
  click(url: string): Promise<void>;
  dispose(): void;
}

// A parse of (label, source) over a base, under a palette set. `base` is a
// singleton per module registry, so it keys by identity; text and palettes key
// by content, so a test that builds its palette set afresh still hits.
//
// [LAW:types-are-the-program] The shared config is not frozen: it is `readonly`
// throughout by type, and a runtime freeze would reach `DEFAULT_DSL_CONFIG`'s
// own decl objects (`mergeWithDefault` is shallow), which a test does not own.
//
// A parse also reads the option-domain registry (cross-ref resolves a `from` to
// its members), so the key carries each registered domain's members as they
// stood when it ran: a test that registers a domain around a parse never shares
// it with one that does not, nor with one that registered the same name over
// other members.
const parses = new WeakMap<DslConfig, Map<string, ValidatedConfig>>();

// A compile is shared by its config key. It holds no store, but it carries
// per-walk state — `activeSegment` (set while a segment renders),
// `menuRuntime.action.bound` (the render's binding: `bindRender` sets it for the
// walk and drops it on every exit, a second live bind throws) and the per-store
// `views` map. Sharing is safe because every bind is synchronous and exclusive
// and one test file's draws run one at a time; an overlap would throw.
const compiles = new Map<string, CompiledConfig>();

function held<K extends object, V>(
  memo: WeakMap<K, Map<string, V>>,
  key: K,
): Map<string, V> {
  let entries = memo.get(key);
  if (entries === undefined) {
    entries = new Map();
    memo.set(key, entries);
  }
  return entries;
}

function registeredDomains(): readonly (readonly [
  string,
  readonly string[],
])[] {
  const none = new Map();
  return knownOptionDomainNames(none).map((name) => [
    name,
    resolveOptionDomain(name, none).members,
  ]);
}

/** The parse of `source` over `base`, built once and handed to every rig that asks. */
export function parsedConfig(
  label: string,
  source: string,
  base: DslConfig,
  palettes: ReadonlySet<string>,
): ValidatedConfig {
  const entries = held(parses, base);
  const key = JSON.stringify([
    label,
    source,
    [...palettes].sort(),
    registeredDomains(),
  ]);
  let config = entries.get(key);
  if (config === undefined) {
    config = parseAndValidate(label, source, palettes, base);
    entries.set(key, config);
  }
  return config;
}

/** A compile provider that hands back the compile held for a key, building it on first ask. */
export const sharedCompile: CompileProvider = (key, input) => {
  let compiled = compiles.get(key);
  if (compiled === undefined) {
    compiled = compileDslConfig(input);
    compiles.set(key, compiled);
  }
  return compiled;
};

export function buildRig(init: RigInit = {}): Rig {
  const sessionId = init.sessionId ?? SESSION_ID;
  const cwd = init.cwd ?? CWD;
  const config = parsedConfig(
    init.label ?? "<test>",
    init.source ?? "{}",
    init.base ?? EMPTY_DEFAULT,
    init.palettes ?? ALL_PALETTES,
  );
  const drawn = (init.narrow ?? ((whole) => whole))(config);
  const sessionState = init.sessionState ?? new SessionState();
  const store = new VariableStore(systemTimekeeper);
  const ctx = testVerbContext(sessionState, init.history, config, init.host);
  // A fixture can set up a disclosure directly. Use the production view
  // once a real click opens an edit transaction.
  const view = {
    ...ctx.edits.view,
    get: (sid: SessionId, key: string) =>
      ctx.edits.draft(sid) === null
        ? sessionState.get(sid, key)
        : ctx.edits.view.get(sid, key),
  };
  const registry = new SourceRegistry(store, "", view, null);
  const readings = readingsIn(init.env ?? {});
  const registered = registerCompiled(
    drawn,
    registry,
    cwd,
    sharedCompile,
    EVERY_SCOPE,
  );
  const compiled = {
    ...registered.compiled,
    loadWarnings: registered.loadWarnings,
  };
  // A click resolves the config the host's book holds of its session, so a
  // rig records one unless the caller's book already holds the session.
  if (bookedContext(sessionState, sessionId) === null) {
    recordRender(sessionState, sessionId, cwd);
  }
  return {
    config,
    compiled,
    store,
    registry,
    sessionState,
    sessionId,
    ctx,
    draw: (draw = {}) => {
      const payload = draw.payload ?? {
        session_id: sessionId,
        workspace: { project_dir: cwd },
      };
      // [LAW:one-source-of-truth] The rig is one session: the one its picks,
      // its booking and its clicks are under. A payload drawing another
      // would draw a view whose picks nothing here reads or writes.
      const session = sessionOfPayload(payload);
      if (session !== sessionId)
        throw new Error(
          `the rig is session ${sessionId}, but the payload draws session ${session}`,
        );
      const selection =
        draw.selection ??
        selectionFor(config, {}, (key) => view.get(sessionId, key));
      return {
        ...drawPayload(
          drawn,
          compiled,
          store,
          registry,
          payload,
          draw.at ?? instantOf(new Date()),
          { ...RIG_OPTS, ...draw.opts },
          selection,
          readings,
        ),
        selection,
      };
    },
    click: (url) => clickUrl(url, ctx),
    dispose: () => registry.dispose(),
  };
}
