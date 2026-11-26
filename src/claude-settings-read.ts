// [LAW:effects-at-boundaries] The reads of Claude Code's settings files: the
// host opens them, and the paths and the parse both sides read are shared
// (src/claude-settings.ts).

import { types } from "node:util";
import { EMPTY_DOCUMENT, JSON_DIALECT } from "./config/json5-edit.js";
import { failed, ok, type Failed, type Ok } from "./utils/outcome.js";
import { readTextIfPresent } from "./utils/regular-text.js";
import { type JsonObject, isJsonObject } from "./claude-settings";

const cannotRead = (settingsPath: string, e: unknown): Error =>
  new Error(`cannot read ${settingsPath}: ${messageOf(e)}`, { cause: e });

// The settings file's bytes, or null when there is no file — the one absence
// with a meaning: Claude Code has written nothing yet.
export function readClaudeSettingsText(settingsPath: string): string | null {
  try {
    return readTextIfPresent(settingsPath);
  } catch (error) {
    throw new Error(`cannot read ${messageOf(error)}`, { cause: error });
  }
}

// [LAW:types-are-the-program] A settings file as it was read.
export interface ClaudeSettings {
  // Its bytes, null when there is no file: what a write over it must find
  // there still.
  readonly text: string | null;
  // The text an edit splices: the file's, or the empty document where Claude
  // Code has written nothing yet.
  readonly edited: string;
  readonly document: JsonObject;
}

// [LAW:one-source-of-truth] The ONE reading of Claude Code's settings as a
// document, shared by install and the auto-compact window. A missing file
// means Claude Code has written nothing yet. Existing text that does not
// parse, or parses to anything but an object,
// throws naming the file ([LAW:no-silent-failure]: Claude Code is not running
// with whatever a guess would say).
export function parseClaudeSettings(
  settingsPath: string,
  text: string | null,
): ClaudeSettings {
  if (text === null) return { text, edited: EMPTY_DOCUMENT, document: {} };
  let parsed: unknown;
  try {
    parsed = JSON_DIALECT.parse(text);
  } catch (e) {
    throw cannotRead(settingsPath, e);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`cannot read ${settingsPath}: not a JSON object`);
  }
  return { text, edited: text, document: parsed };
}

export function readClaudeSettings(settingsPath: string): ClaudeSettings {
  return parseClaudeSettings(
    settingsPath,
    readClaudeSettingsText(settingsPath),
  );
}

// The same reading as an outcome that says which phase failed: the file could
// not be read, or its text was not a settings document. A fact carries the
// phase (src/utils/outcome.ts), and the two are different repairs.
export function readClaudeSettingsOutcome(
  settingsPath: string,
): Ok<JsonObject> | Failed {
  let text: string | null;
  try {
    text = readClaudeSettingsText(settingsPath);
  } catch (e) {
    return failed(messageOf(e), "read");
  }
  try {
    return ok(parseClaudeSettings(settingsPath, text).document);
  } catch (e) {
    return failed(messageOf(e), "parse");
  }
}

// [LAW:types-are-the-program] The statusLine setting as cc-candybar reads it:
// the command Claude Code runs from it, null when it names none.
export interface StatusLine {
  readonly command: string | null;
}

// [LAW:parse-dont-validate] The setting, or null when it is unset. Any other
// shape is refused naming the file and the key, so nothing acts on a
// malformed setting as though it were one.
export function parseStatusLine(
  settingsPath: string,
  settings: JsonObject,
): StatusLine | null {
  const { statusLine } = settings;
  if (statusLine === undefined) return null;
  if (!isJsonObject(statusLine))
    throw malformed(settingsPath, "statusLine", "an object", statusLine);
  const { command } = statusLine;
  if (command === undefined) return { command: null };
  if (typeof command !== "string")
    throw malformed(settingsPath, "statusLine.command", "a string", command);
  return { command };
}

const malformed = (
  settingsPath: string,
  key: string,
  wanted: string,
  found: unknown,
): Error =>
  new Error(
    `cannot read ${settingsPath}: ${key} is ${JSON.stringify(found)}, not ${wanted}`,
  );

const messageOf = (e: unknown): string =>
  types.isNativeError(e) ? e.message : String(e);
