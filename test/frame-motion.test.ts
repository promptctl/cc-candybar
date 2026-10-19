// [LAW:verifiable-goals] brandon-doctor-v62x.tgp: whether a frame moves is read
// off the cells it drew, so a template's `frames` moves the bar exactly as an
// effect does, and a bar with neither is still.

import { SessionState } from "../src/daemon/session-state";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import {
  registerDslConfig,
  drawDsl,
  type FrameMotion,
} from "../src/dsl/render";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import type { Instant } from "../src/utils/instant";
import { parseAndValidate } from "./helpers/parse-and-validate";

const AT = 1_800_000_000 as Instant;

// The motion of the one frame a config of one `cell` segment draws, under the
// globals given (JSON5 text).
function motionOf(
  template: string,
  globals = "{}",
  root = '{ h: ["cell"] }',
): FrameMotion {
  const config = parseAndValidate(
    "<test>",
    `{ globals: ${globals}, segments: { cell: { template: ${JSON.stringify(template)} } }, root: ${root} }`,
    undefined,
    DEFAULT_DSL_CONFIG,
  );
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp" });
  try {
    return drawDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: "s" },
      AT,
      {
        endcaps: "powerline",
        colorCompatibility: "truecolor",
        wrap: true,
        padding: 1,
        width: 160,
      },
    ).motion;
  } finally {
    registry.dispose();
  }
}

describe("a drawn frame says whether it moves", () => {
  test("a bar of still text under no effect is still", () => {
    expect(motionOf("still")).toBe("still");
  });

  test("a template's frames move it, with no effect on", () => {
    expect(motionOf('{{ frames 1 "a" 1 "b" }}')).toBe("moves");
  });

  test("the bar's effect moves it", () => {
    expect(motionOf("still", '{ effect: "pulse" }')).toBe("moves");
  });

  test("an effect rule that names no effect now can move it later", () => {
    expect(motionOf("still", `{ effect: '{{ "none" }}' }`)).toBe("can-move");
  });

  test("a placement wearing its own effect, hidden now, can move it later", () => {
    expect(
      motionOf(
        "still",
        "{}",
        `{ h: [{ seg: "cell", when: "{{ false }}", settings: { effect: "pulse" } }, "model"] }`,
      ),
    ).toBe("can-move");
  });

  test("placements that fade as they come and go can move it later", () => {
    expect(motionOf("still", "{ transitions: true }")).toBe("can-move");
  });
});
