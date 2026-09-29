// What a synthesis pass reads, ensured from PAYLOAD_INPUTS when the config
// does not declare it (brandon-settings-menu-d6f.6j4).

import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import type { DslConfig, LayoutNode } from "../src/config/dsl-types";
import { PAYLOAD_INPUTS } from "../src/config/payload-inputs";
import { synthesisInputs } from "../src/config/synthesis-inputs";

const BARE: DslConfig = { ...DEFAULT_DSL_CONFIG, variables: {} };
const NONE = { variables: {}, actions: {}, segments: {} };

describe("synthesisInputs", () => {
  test("a state variable reads session.id, with no action minted", () => {
    const ensured = synthesisInputs(
      {
        ...NONE,
        variables: { "x.open": { kind: "state", key: "x.open", default: "" } },
      },
      [],
      BARE,
    );
    expect(ensured["session.id"]).toEqual(PAYLOAD_INPUTS["session.id"]);
  });

  test("a read in a `when` of a returned tree is ensured", () => {
    const tree: LayoutNode = {
      kind: "container",
      direction: "vertical",
      children: [{ kind: "segment", name: "a", when: "{{ .project_dir }}" }],
    };
    const ensured = synthesisInputs(NONE, [tree], BARE);
    expect(ensured["project_dir"]).toEqual(PAYLOAD_INPUTS["project_dir"]);
  });

  test("a field read of the config's own json document resolves", () => {
    const config: DslConfig = {
      ...BARE,
      variables: {
        budget: {
          kind: "file",
          path: "/tmp/budget.json",
          parse: { json: true },
          cache: { watch_file: "/tmp/budget.json" },
        },
      },
    };
    const tree: LayoutNode = {
      kind: "segment",
      name: "a",
      when: "{{ gt .budget.spent 1 }}",
    };
    expect(synthesisInputs(NONE, [tree], config)).toEqual({});
  });
});
