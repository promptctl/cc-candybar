// Merges with an EMPTY default so a "this user file is missing X" assertion cannot pass because the bundled default supplies X.
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
  root: { rows: {} },
  actions: {},
  looks: {},
  presets: {},
  helpers: {},
  editGlobals: {},
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
