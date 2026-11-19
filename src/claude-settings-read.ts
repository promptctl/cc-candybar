// [LAW:effects-at-boundaries] The reads of Claude Code's settings files: the
// host opens them, and the paths and the parse both sides read are shared
// (src/claude-settings.ts).

import { types } from "node:util";
import { JSON_DIALECT } from "./config/json5-edit.js";
import { failed, ok, type Failed, type Ok } from "./utils/outcome.js";
import { readRegularTextSync } from "./utils/regular-text.js";
import { type JsonObject, isJsonObject } from "./claude-settings";
import type { JsonValue } from "./var-system/types.js";

const cannotRead = (settingsPath: string, e: unknown): Error =>
  new Error(`cannot read ${settingsPath}: ${messageOf(e)}`, { cause: e });

// The settings file's bytes, for an editor that splices it. A missing file is
// the one absence with a meaning — Claude Code has written nothing yet — so it
// reads as the empty document.
export function readClaudeSettingsText(settingsPath: string): string {
  try {
    return readRegularTextSync(settingsPath);
  } catch (e) {
    // [LAW:no-silent-failure] The install can create a missing settings file.
    // A settings file it could not read is an error the user can act on.
    if (
      types.isNativeError(e) &&
      "code" in e &&
      (e.code === "ENOENT" || e.code === "ENOTDIR")
    )
      return "";
    throw cannotRead(settingsPath, e);
  }
}

// [LAW:one-source-of-truth] The ONE reading of Claude Code's settings as a
// document, shared by install and the auto-compact window.
// Empty text — a missing file or a blank one — is the empty document; text
// that does not parse, or parses to anything but an object, throws naming the
// file ([LAW:no-silent-failure]: Claude Code is not running with whatever a
// guess would say).
export function readClaudeSettings(settingsPath: string): JsonObject {
  const settings = readClaudeSettingsOutcome(settingsPath);
  if (settings.kind === "failed") throw new Error(settings.reason);
  return settings.value;
}

// The same reading as an outcome that says which phase failed: the file could
// not be read, or its text was not a settings document. A fact carries the
// phase (src/utils/outcome.ts), and the two are different repairs.
export function readClaudeSettingsOutcome(
  settingsPath: string,
): Ok<JsonObject> | Failed {
  let text: string;
  try {
    text = readClaudeSettingsText(settingsPath);
  } catch (e) {
    return failed(messageOf(e), "read");
  }
  try {
    return ok(parseSettings(settingsPath, text));
  } catch (e) {
    return failed(messageOf(e), "parse");
  }
}

function parseSettings(settingsPath: string, text: string): JsonObject {
  let parsed: JsonValue;
  try {
    if (/^\s*$/.test(text)) return {};
    // [LAW:parse-dont-validate] JSON text parses to JSON values.
    parsed = JSON_DIALECT.parse(text) as JsonValue;
  } catch (e) {
    throw cannotRead(settingsPath, e);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`cannot read ${settingsPath}: not a JSON object`);
  }
  return parsed;
}

const messageOf = (e: unknown): string =>
  types.isNativeError(e) ? e.message : String(e);
