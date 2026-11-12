// What a synthesis pass reads resolves against what the config and the pass
// declare; a read nothing declares is a load error (brandon-settings-menu-d6f.6j4).

import { DEFAULT_DSL_CONFIG } from "../../src/config/default-dsl-config";
import type { DslConfig, LayoutNode } from "../../src/config/dsl-types";
import { checkSynthesisReads } from "../../src/config/synthesis-inputs";

const BARE: DslConfig = { ...DEFAULT_DSL_CONFIG, variables: {} };
const NONE = { variables: {}, actions: {}, segments: {} };

describe("checkSynthesisReads", () => {
  test("a read in a `when` of a returned tree that nothing declares throws, naming it", () => {
    const tree: LayoutNode = {
      kind: "container",
      direction: "vertical",
      children: [{ kind: "segment", name: "a", when: "{{ .project_dir }}" }],
    };
    expect(() => checkSynthesisReads(NONE, [tree], BARE)).toThrow(
      '".project_dir"',
    );
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
    expect(() => checkSynthesisReads(NONE, [tree], config)).not.toThrow();
  });
});
