// The bundled bar drawn in process under one session's picks: the real loader,
// `resolveEffectiveGlobals` and `drawDsl`, on check's payload, exactly as a
// click on the bar would leave it.
//
// [LAW:one-source-of-truth] The settings-menu tests that drive the bar by its
// session picks and the accent-looks harness (proto-looks/) draw through this
// one rig, so a field the render path comes to need reaches them all.

import { drawPayload } from "./draw-payload";
import { processLauncher } from "../../src/proc/launch";
import type { RichText } from "@promptctl/rich-js";
import { DEFAULT_DSL_CONFIG } from "../../src/config/default-dsl-config";
import { resolveEffectiveGlobals } from "../../src/config/effective-globals";
import { perSetting } from "../../src/config/setting-projections";
import { CHECK_TODAY, checkPayload } from "../../src/check";
import { renderOptionsOf } from "../../src/daemon/render-payload";
import type { Frame } from "../../src/render/frame";
import { SessionState } from "../../src/daemon/session-state";
import { registerDslConfig, type RenderWarning } from "../../src/dsl/render";
import { listResolvablePaletteNames } from "../../src/themes/policy";
import type { Instant } from "../../src/utils/instant";
import { SourceRegistry } from "../../src/var-system/sources";
import { VariableStore } from "../../src/var-system/store";
import { TEST_SIGNER } from "./link-signer";
import { parseAndValidate } from "./parse-and-validate";

const SID = "bar00a1b-2c3d-4e5f-8a7b-8c9d0e1f2a3b";

/** A payload's values: what a render's templates read. */
export type Payload = Record<string, unknown>;

export interface SessionRender {
  readonly frame: Frame;
  readonly warnings: readonly RenderWarning[];
  /** Each segment the frame drew, by placement id: its cells before they are joined. */
  readonly segments: ReadonlyMap<string, readonly RichText[]>;
}

export interface SessionBar {
  /** Set one of the session's picks, as a click on the bar would. */
  pick(key: string, value: string): void;
  /** Drop one of the session's picks, so the config's own value holds. */
  unpick(key: string): void;
  /**
   * The bar at `at`, on check's payload as `shown` reshapes it. A segment
   * error throws, because a ⚠ cell is never the bar under test.
   */
  render(at: Instant, shown?: (payload: Payload) => Payload): SessionRender;
  dispose(): void;
}

/** The bundled default under `configSource` (JSON5 over it), drawn `cols` wide. */
export function sessionBar(configSource: string, cols: number): SessionBar {
  const config = parseAndValidate(
    "<user>",
    configSource,
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );
  const session = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", session);
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/home/tester/code/project" });
  return {
    pick: (key, value) => session.set(SID, key, value),
    unpick: (key) => session.clear(SID, key),
    render: (at, shown = (payload) => payload) => {
      const effective = resolveEffectiveGlobals(config, (key) => session.get(SID, key), () => false);
      const payload = {
        ...shown({ ...checkPayload(config, effective, null, at), today: CHECK_TODAY }),
        resettable: perSetting(() => false),
        unsaved: 0,
        history: { undo: 0, redo: 0 },
        session_id: SID,
        term: { cols },
      };
      const warnings: RenderWarning[] = [];
      const segments = new Map<string, readonly RichText[]>();
      const { frame } = drawPayload(config, compiled, store, registry, payload, at, renderOptionsOf(effective, cols), {
        perSegmentSink: segments,
        // [LAW:no-silent-failure] A ⚠ cell would be read as the bar it replaced.
        onSegmentError: (name, message) => {
          throw new Error(`${name}: ${message}`);
        },
        onRenderWarning: (warning) => warnings.push(warning),
      }, effective);
      return { frame, warnings, segments };
    },
    dispose: () => registry.dispose(),
  };
}
