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
  inheritableSegmentNames,
  parseDslConfig,
  mergeWithDefault,
  validateRenderable,
  type AuthoredConfig,
  type Renderable,
} from "../../src/config/dsl-loader";
import type { DslConfig, ValidatedConfig } from "../../src/config/dsl-types";

// A test's own slice alone.
export const EMPTY_DEFAULT: DslConfig = {
  globals: {},
  variables: {},
  segments: {},
  root: { rows: {} },
  actions: {},
  styles: {},
  presets: {},
  helpers: {},
  editGlobals: {},
  themeDefaults: {},
};

// The judgment `check` makes: the bar's own validation, refusing every
// placement it would drop rather than drawing past it.
export function validateConfig(
  authored: AuthoredConfig,
  filePath = "<config>",
  allowedPalettes?: ReadonlySet<string>,
): ValidatedConfig {
  const { config, dropped } = validateRenderable(
    authored,
    new Map(),
    filePath,
    allowedPalettes,
  );
  if (dropped.length > 0) throw dropped[0];
  return config;
}

// The config `loadConfig` would hand validation: parsed with the same
// delta-accepting set loadConfig derives from the default it merges over, so a
// test's cascade is production's.
function authoredOf(
  filePath: string,
  source: string,
  allowedPalettes: ReadonlySet<string> | undefined,
  dflt: DslConfig,
): AuthoredConfig {
  const raw = parseDslConfig(
    filePath,
    source,
    allowedPalettes,
    inheritableSegmentNames(dflt),
  );
  return { config: mergeWithDefault(raw, dflt), raw, source };
}

// The whole pipeline's result, placements and drops included, for a test that
// reads past the validated config.
export function parseAndPlace(
  filePath: string,
  source: string,
  allowedPalettes?: ReadonlySet<string>,
  dflt: DslConfig = EMPTY_DEFAULT,
): Renderable {
  return validateRenderable(
    authoredOf(filePath, source, allowedPalettes, dflt),
    new Map(),
    filePath,
    allowedPalettes,
  );
}

export function parseAndValidate(
  filePath: string,
  source: string,
  allowedPalettes?: ReadonlySet<string>,
  dflt: DslConfig = EMPTY_DEFAULT,
): ValidatedConfig {
  return validateConfig(
    authoredOf(filePath, source, allowedPalettes, dflt),
    filePath,
    allowedPalettes,
  );
}
