// [LAW:single-enforcer] One home for config-error reporting: the public issue/
// error types, the best-effort source-line lookup every validator calls, the
// human-readable formatter ConfigError renders, and the advisory that names
// what the config-file editor would refuse. Changes here are display/source-
// mapping changes; the schema validators never touch this file.

import { Json5EditError, parseDocument } from "../json5-edit.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface ConfigIssue {
  /** Dotted logical path inside the config (e.g., "variables.foo.cache"). */
  readonly path: string;
  /** Short, actionable description of the problem. */
  readonly message: string;
  /** Source line (1-based). For semantic errors, best-effort from the path. */
  readonly line?: number;
  /** Source column (1-based). Present only for parse errors. */
  readonly col?: number;
}

export class ConfigError extends Error {
  readonly file: string;
  readonly issues: readonly ConfigIssue[];

  constructor(file: string, issues: readonly ConfigIssue[]) {
    super(formatIssues(file, issues));
    this.name = "ConfigError";
    this.file = file;
    this.issues = issues;
  }
}

// ─── Best-effort source-line lookup ──────────────────────────────────────────

// Walk source forward, finding each path component as a JSON5 key in turn.
// JSON5 keys are unquoted identifiers (`foo:`), double-quoted strings, or
// single-quoted strings. Numeric path parts (e.g., layout indices) are
// skipped — they point inside arrays where line lookup is less useful.
//
// This is "good enough" navigation, not a guarantee. Returns undefined if a
// path part can't be located — the caller falls back to the logical path.
export function findKeyLine(
  source: string,
  pathParts: readonly string[],
): number | undefined {
  let cursor = 0;
  let foundCursor: number | undefined;
  for (const part of pathParts) {
    if (part === "" || /^\d+$/.test(part)) continue;
    const found = findKeyOccurrence(source, cursor, part);
    if (found === -1) {
      return foundCursor !== undefined
        ? lineFromOffset(source, foundCursor)
        : undefined;
    }
    cursor = found;
    foundCursor = found;
  }
  return foundCursor !== undefined
    ? lineFromOffset(source, foundCursor)
    : undefined;
}

function findKeyOccurrence(source: string, from: number, key: string): number {
  // Match `<key>:` or `"<key>":` or `'<key>':` — any whitespace before the colon
  // is allowed by JSON5. Escape regex specials in key.
  const escaped = key.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  const re = new RegExp(`(?:["']${escaped}["']|\\b${escaped}\\b)\\s*:`, "g");
  re.lastIndex = from;
  const m = re.exec(source);
  return m ? m.index : -1;
}

function lineFromOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 0x0a) line++;
  }
  return line;
}

// ─── Editability advisory ────────────────────────────────────────────────────

/**
 * The advisory a config file earns when the settings menu could not edit it:
 * JSON5.parse tolerates a duplicate object key (the last one wins), while the
 * config-file editor refuses to splice a document whose meaning is ambiguous
 * (brandon-config-16g). Without this, a copy-paste duplicate surfaces first
 * as a durable-click failure, far from the line that caused it. Returns the
 * warning naming the file, the line, and the editor's own reason — or null
 * when the editor accepts the document.
 *
 * [LAW:single-enforcer] The editor's span scanner IS the detector: this runs
 * `parseDocument` over the source and reports its refusal. There is no second
 * duplicate-key scan to drift from the one a click hits, and any OTHER
 * document the editor would refuse (a scanner/JSON5 disagreement) is named
 * here for the same reason — early, on the bar, before any click.
 *
 * [LAW:dataflow-not-control-flow] Runs on every load of every file; the
 * outcome is a value (a notice or its absence), never a skipped pass.
 */
export function editabilityNotice(
  filePath: string,
  source: string,
): string | null {
  try {
    parseDocument(source);
    return null;
  } catch (e) {
    if (!(e instanceof Json5EditError)) throw e;
    return `${filePath}:${lineFromOffset(source, e.offset)}: ${e.reason} — the settings menu cannot edit this file until it is fixed`;
  }
}

// ─── Error formatting ────────────────────────────────────────────────────────

function formatIssues(file: string, issues: readonly ConfigIssue[]): string {
  if (issues.length === 0) return `${file}: invalid config (no details)`;
  const lines: string[] = [
    `Invalid config in ${file} (${issues.length} issue${issues.length === 1 ? "" : "s"}):`,
  ];
  for (const issue of issues) {
    const locParts: string[] = [];
    if (issue.line !== undefined) {
      locParts.push(
        `line ${issue.line}${issue.col !== undefined ? `:${issue.col}` : ""}`,
      );
    }
    if (issue.path) locParts.push(issue.path);
    const loc = locParts.length > 0 ? `[${locParts.join(" • ")}] ` : "";
    lines.push(`  ${loc}${issue.message}`);
  }
  return lines.join("\n");
}
