// [LAW:one-type-per-behavior] Test helper that runs the full three-stage
// pipeline (parse → merge → validate) and returns a ValidatedConfig — what
// tests asserting end-to-end config behavior actually want.
//
// Tests default to merging with an EMPTY default config (not DEFAULT_DSL_CONFIG)
// so cross-reference assertions exercise the user's own slice in isolation —
// a test asserting "this user file is missing X" must not silently pass
// because the bundled default supplies X. Tests that genuinely want the
// production cascade pass DEFAULT_DSL_CONFIG explicitly.
import {
  parseDslConfig,
  mergeWithDefault,
  validateConfig,
} from "../../src/config/dsl-loader";
import type {
  DslConfig,
  ValidatedConfig,
} from "../../src/config/dsl-types";

const EMPTY_DEFAULT: DslConfig = {
  globals: {},
  variables: {},
  segments: {},
  root: { kind: "container", direction: "vertical", children: [] },
  actions: {},
  looks: {},
  presets: {},
  helpers: {},
};

export function parseAndValidate(
  filePath: string,
  source: string,
  allowedPalettes?: ReadonlySet<string>,
  dflt: DslConfig = EMPTY_DEFAULT,
): ValidatedConfig {
  const raw = parseDslConfig(filePath, source, allowedPalettes);
  const merged = mergeWithDefault(raw, dflt);
  return validateConfig(merged, filePath, source, allowedPalettes);
}
