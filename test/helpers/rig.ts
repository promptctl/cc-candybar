// The rig a render test draws and clicks through: a config composed into a
// store and a registry, the way `cc-candybar check` and the daemon compose one.
// Every field has a default, so a test states only what it varies.
//
// [LAW:one-source-of-truth] This is the one assembly. A test file keeps its own
// vocabulary (which link to click, which cell to read) and no longer its own copy
// of parse → store → registry → compile → draw.
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
import { SessionState } from "../../src/daemon/session-state";
import {
  compileDslConfig,
  registerCompiled,
  EVERY_SCOPE,
  type CompiledConfig,
  type CompileProvider,
  type DrawnFrame,
  type RegisteredConfig,
  type RenderObservers,
  type RenderSelection,
} from "../../src/dsl/render";
import type { LinkSigner } from "../../src/click/link-signer";
import type { VerbContext } from "../../src/daemon/verbs";
import type { SettingsHistory } from "../../src/daemon/settings-history";
import type { Host } from "../../src/host";
import type { BuildLineOptions } from "../../src/render/strip";
import { listResolvablePaletteNames } from "../../src/themes/policy";
import { instantOf, type Instant } from "../../src/utils/instant";
import { systemTimekeeper } from "../../src/time";
import { SourceRegistry } from "../../src/var-system/sources";
import { VariableStore } from "../../src/var-system/store";
import { clickUrl, recordRender, testVerbContext } from "./click";
import { drawPayload } from "./draw-payload";
import { processLauncher } from "./host";
import { TEST_SIGNER } from "./link-signer";
import { EMPTY_DEFAULT, parseAndValidate } from "./parse-and-validate";
import { selectionFor } from "./selection";

export { DEFAULT_DSL_CONFIG, EMPTY_DEFAULT };

const SESSION_ID = "s1";
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
  /** The directory `shell` sources run in; the session's project directory. */
  readonly cwd?: string;
  /** The environment an `env` source reads. */
  readonly env?: Readonly<Record<string, string>>;
  /** The session the rig draws and clicks as, and its state (a test sharing one across rigs hands it in). */
  readonly sessionId?: string;
  readonly sessionState?: SessionState;
  /** What the click path is built with beyond the config: the history and host a durable-config test owns. */
  readonly history?: SettingsHistory;
  readonly host?: Host;
  readonly signer?: LinkSigner;
  /**
   * Whether the session has rendered, as it always has before a click: a click
   * resolves the config its session's last render recorded.
   */
  readonly rendered?: boolean;
}

export interface DrawInit {
  /** The payload, whole. Defaults to the session's id and project directory. */
  readonly payload?: object;
  readonly opts?: Partial<BuildLineOptions>;
  readonly at?: Instant;
  readonly observers?: RenderObservers;
  /** The selection, whole. Defaults to the daemon's resolution over the session's picks. */
  readonly selection?: RenderSelection;
}

export interface Rig {
  readonly config: ValidatedConfig;
  readonly compiled: RegisteredConfig;
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
  readonly sessionState: SessionState;
  readonly sessionId: string;
  /** The context a click runs in: a test that overrides a field spreads it. */
  readonly ctx: VerbContext;
  /** The frame the session draws now. */
  draw(init?: DrawInit): DrawnFrame;
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
// The key is the parse's inputs, not the registries a parse reads (option
// domains): a test that registers a domain before parsing and removes it after
// gives its source a label of its own, or a later parse of the same text hits.
const parses = new WeakMap<DslConfig, Map<string, ValidatedConfig>>();

// A compile is shared by what a compile takes: its config (the key) and its
// signer. It holds no store, but it is not an immutable value: it carries
// per-walk state — `activeSegment` (set while a segment renders),
// `menuRuntime.action.bound` (the render's binding: `bindRender` sets it for the
// walk and drops it on every exit, a second live bind throws) and the per-store
// `views` map. Sharing is safe because every bind is synchronous and exclusive
// and one test file's draws run one at a time; an overlap would throw.
const compiles = new WeakMap<LinkSigner, Map<string, CompiledConfig>>();

function held<K extends object, V>(memo: WeakMap<K, Map<string, V>>, key: K): Map<string, V> {
  let entries = memo.get(key);
  if (entries === undefined) {
    entries = new Map();
    memo.set(key, entries);
  }
  return entries;
}

/** The parse of `source` over `base`, built once and handed to every rig that asks. */
export function parsedConfig(
  label: string,
  source: string,
  base: DslConfig,
  palettes: ReadonlySet<string>,
): ValidatedConfig {
  const entries = held(parses, base);
  const key = JSON.stringify([label, source, [...palettes].sort()]);
  let config = entries.get(key);
  if (config === undefined) {
    config = parseAndValidate(label, source, palettes, base);
    entries.set(key, config);
  }
  return config;
}

/** A compile provider that hands back the compile held for a key, building it on first ask. */
export function sharedCompile(signer: LinkSigner): CompileProvider {
  const entries = held(compiles, signer);
  return (key, input) => {
    let compiled = entries.get(key);
    if (compiled === undefined) {
      compiled = compileDslConfig(input, signer);
      entries.set(key, compiled);
    }
    return compiled;
  };
}

export function buildRig(init: RigInit = {}): Rig {
  const sessionId = init.sessionId ?? SESSION_ID;
  const cwd = init.cwd ?? CWD;
  const config = parsedConfig(
    init.label ?? "<test>",
    init.source ?? "{}",
    init.base ?? EMPTY_DEFAULT,
    init.palettes ?? ALL_PALETTES,
  );
  const sessionState = init.sessionState ?? new SessionState();
  const store = new VariableStore(systemTimekeeper);
  const registry = new SourceRegistry(
    processLauncher,
    store,
    "",
    sessionState,
    null,
    undefined,
    undefined,
    undefined,
    init.env,
  );
  const registered = registerCompiled(
    config,
    registry,
    cwd,
    sharedCompile(init.signer ?? TEST_SIGNER),
    EVERY_SCOPE,
  );
  const compiled = { ...registered.compiled, loadWarnings: registered.loadWarnings };
  if (init.rendered ?? true) recordRender(sessionState, sessionId, cwd);
  const ctx = testVerbContext(sessionState, init.history, config, init.host);
  return {
    config,
    compiled,
    store,
    registry,
    sessionState,
    sessionId,
    ctx,
    draw: (draw = {}) =>
      drawPayload(
        config,
        compiled,
        store,
        registry,
        draw.payload ?? { session_id: sessionId, project_dir: cwd },
        draw.at ?? instantOf(new Date()),
        { ...RIG_OPTS, ...draw.opts },
        draw.observers,
        draw.selection ?? selectionFor(config, {}, (key) => sessionState.get(sessionId, key)),
      ),
    click: (url) => clickUrl(url, ctx),
    dispose: () => registry.dispose(),
  };
}
