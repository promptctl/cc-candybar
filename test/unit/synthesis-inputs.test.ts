// What the settings menu and edit chrome mint reads only payload inputs and
// their own names, so its reads resolve whatever the config holds; a read
// nothing declares is named (brandon-settings-menu-d6f.6j4).

import { DEFAULT_DSL_CONFIG } from "../../src/config/default-dsl-config";
import {
  inheritableSegmentNames,
  mergeWithDefault,
  parseDslConfig,
  validateRenderable,
} from "../../src/config/dsl-loader";
import type { DslConfig } from "../../src/config/dsl-types";
import { unresolvedReads } from "../../src/config/synthesis-inputs";
import { EMPTY_DEFAULT } from "../helpers/parse-and-validate";

const loaded = (dflt: DslConfig) => {
  const raw = parseDslConfig(
    "<t>",
    "{}",
    undefined,
    inheritableSegmentNames(dflt),
  );
  const config = mergeWithDefault(raw, dflt);
  return validateRenderable({ config, raw, source: "{}" }, new Map());
};

describe("unresolvedReads", () => {
  test.each([
    ["the bundled default", DEFAULT_DSL_CONFIG],
    ["a config that declares nothing", EMPTY_DEFAULT],
  ])("every read the chrome mints over %s resolves", (_, dflt) => {
    const { config, placed } = loaded(dflt);
    expect(unresolvedReads(config, placed)).toEqual([]);
  });

  test("a minted read that nothing declares is named", () => {
    const { config, placed } = loaded(EMPTY_DEFAULT);
    const broken: DslConfig = {
      ...config,
      segments: { ...config.segments, minted: { template: "{{ .ghost }}" } },
    };
    expect(unresolvedReads(broken, placed)).toEqual(["ghost"]);
  });
});
