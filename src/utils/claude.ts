import type { CheckoutLocation } from "./git-root.js";
import { existsSync } from "node:fs";
// [LAW:single-enforcer] readdir and the forward read come from the gated
// transcript-fs owner, not node:fs/promises — the in-flight-I/O bound lives at
// one seam.
import {
  decodeLines,
  readAppended,
  readdir,
  type WholeLines,
} from "./transcript-fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { debug } from "./logger";
import { ok, type Outcome } from "./outcome";
import {
  entryActivity,
  turnText,
  type EntryActivity,
} from "./transcript-activity";

export interface ClaudeHookData {
  // cc-candybar internal — not part of Anthropic's schema
  hook_event_name: string;

  // Always present per Anthropic schema
  session_id: string;
  transcript_path: string;
  cwd: string;
  model: {
    id: string;
    display_name: string;
  };
  workspace: {
    current_dir: string;
    project_dir: string;
    // "Empty array if none have been added" — documented as always present,
    // but validateHookData admits its absence (a build that omits it still
    // renders) and checks its kind when present; payloadOf's
    // workspace normalization reads absence as none added.
    added_dirs?: string[];
    // Absent when not inside a linked git worktree
    git_worktree?: string;
  };

  // The daemon's, never Claude Code's: read once per request from the checkout.
  location?: CheckoutLocation & { gitPending?: boolean };

  // Optional per Anthropic schema (listed under "Fields that may be absent")
  session_name?: string;
  version?: string;
  output_style?: {
    name: string;
  };
  cost?: {
    total_cost_usd: number;
    total_duration_ms: number;
    total_api_duration_ms: number;
    total_lines_added: number;
    total_lines_removed: number;
  };
  context_window?: {
    total_input_tokens: number;
    total_output_tokens: number;
    context_window_size: number;
    // Always present within context_window, but value may be null (schema: "Fields that may be null")
    used_percentage: number | null;
    remaining_percentage: number | null;
    // Null before first API call and after /compact — present, not absent
    current_usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    } | null;
  };
  exceeds_200k_tokens?: boolean;
  effort?: {
    level: string;
  };
  thinking?: {
    enabled: boolean;
  };
  rate_limits?: {
    five_hour?: {
      used_percentage: number;
      resets_at: number;
    };
    seven_day?: {
      used_percentage: number;
      resets_at: number;
    };
  };
  vim?: {
    mode: string;
  };
  agent?: {
    name: string;
  };
  worktree?: {
    name: string;
    path: string;
    branch?: string;
    original_cwd: string;
    original_branch?: string;
  };
}

// The directories a session's Claude Code keeps its transcripts under:
// the one its client detected (the `claudeConfigDir` hint), else the two
// default locations that exist.
//
// [LAW:single-enforcer] The directory is the client's to report
// (detectClaudeConfigDir, src/claude-settings.ts): this runs in the detached
// daemon, whose own CLAUDE_CONFIG_DIR answers for whichever session spawned it.
export function getClaudePaths(detected: string | undefined): string[] {
  if (detected !== undefined) return [detected];
  const homeDir = homedir();
  return [join(homeDir, ".config", "claude"), join(homeDir, ".claude")].filter(
    (dir) => existsSync(dir),
  );
}

export async function findProjectPaths(
  claudePaths: readonly string[],
): Promise<string[]> {
  const projectPaths: string[] = [];

  for (const claudePath of claudePaths) {
    const projectsDir = join(claudePath, "projects");
    // [LAW:no-silent-failure] A directory with no `projects/` yet has no
    // projects; one that cannot be listed is the caller's failure, never an
    // empty tree.
    const entries = await unlessGone(
      readdir(projectsDir, { withFileTypes: true }),
    );
    for (const entry of entries ?? []) {
      if (entry.isDirectory()) projectPaths.push(join(projectsDir, entry.name));
    }
  }

  return projectPaths;
}

// A read of something that may have gone (or never been): `undefined` on
// ENOENT, the read's own throw otherwise.
export async function unlessGone<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

export async function findAgentTranscripts(
  sessionId: string,
  projectPath: string,
  // [LAW:one-source-of-truth] Agent-file session identity is IMMUTABLE — a file
  // that belonged to this session never changes owner. Paths in `verified` skip
  // the first-line read, so an incremental refold (which passes its prior file
  // set) reads a first line only for NEWLY-appeared sidechains. The readdir
  // still runs (cheap).
  verified?: ReadonlySet<string>,
): Promise<{ paths: string[]; longLines: readonly LongLine[] }> {
  const paths: string[] = [];
  let longLines: readonly LongLine[] = [];

  const subagentsDir = join(projectPath, sessionId, "subagents");

  try {
    const files = await readdir(subagentsDir);
    const agentFileNames = files.filter(
      (f) => f.startsWith("agent-") && f.endsWith(".jsonl"),
    );

    for (const fileName of agentFileNames) {
      const filePath = join(subagentsDir, fileName);
      if (verified?.has(filePath)) {
        paths.push(filePath);
        continue;
      }
      // The first line only: one forward read from the file start, decoding
      // only the bytes before its first newline (a file with no complete line
      // yet is read again next time).
      const read = await readAppended(filePath, undefined, undefined);
      if (read.kind !== "ok") {
        debug(`Failed to check agent file ${filePath}`);
        continue;
      }
      longLines = longLinesWith(longLines, filePath, read.value);
      const line = jsonLine(
        decodeLines(read.value, (b) =>
          b.subarray(0, Math.max(0, b.indexOf(0x0a))).toString("utf-8"),
        ),
      );
      if (line.kind === "object" && line.value.sessionId === sessionId) {
        paths.push(filePath);
      }
    }
  } catch (error) {
    debug(`Failed to read subagents directory ${subagentsDir}:`, error);
  }

  return { paths, longLines };
}

// [LAW:types-are-the-program] exception: kept as type-aliases (not
// interfaces) so they're structurally assignable to `Record<string,
// unknown>` at the `extractModelId` boundary in segments/pricing.ts.
// Switching to `interface` removes the implicit index signature and
// breaks typecheck. A proper fix tightens that boundary to take
// `PrunedRaw` directly and is out of scope for the CI-fix branch.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type UsageCounts = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

// [LAW:one-source-of-truth] The only fields ever read from raw are
// model, message.{id,model,usage}, and requestId. Storing the full
// parsed JSON (including content arrays with full message text) causes
// hundreds of MB of V8 heap churn per transcript re-parse. raw is
// pruned to this shape at parse time so the GC pressure is bounded.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type PrunedRaw = {
  model?: string;
  message?: { id?: string; model?: string; usage?: UsageCounts };
  requestId?: string;
};

export interface ParsedEntry {
  timestamp: Date;
  // [LAW:one-source-of-truth] The pruned projection carries every scalar any
  // consumer reads. `type`, `message.role/type` and `userEntry` are the
  // message-classification discriminators the metrics segment needs; they are
  // small enum-like strings, so projecting them keeps metrics on this one parse
  // path WITHOUT retaining the multi-MB `message.content[]` arrays the pruning
  // exists to drop.
  type?: string;
  message?: {
    id?: string;
    usage?: UsageCounts;
    model?: string;
    role?: string;
    type?: string;
  };
  costUSD?: number;
  isSidechain?: boolean;
  // Who wrote a "user" entry; undefined on every other entry.
  userEntry?: UserEntry;
  // [LAW:one-source-of-truth] What this entry says Claude is DOING, projected
  // here rather than by a second scanner (src/utils/transcript-activity.ts).
  // Same discipline as `userEntry`: bounded scalars out of
  // `message.content[]`, never the array. Undefined for every entry that
  // contributes no activity, which is most of them.
  activity?: EntryActivity;
  raw: PrunedRaw;
}

// A "user" entry is one of five facts, read from the marks Claude Code writes:
// - `prompt`: input Claude answers, a person's or an SDK caller's — the input
//   Claude Code's own `turnPosition.promptIndex` counts.
// - `turn`: Claude Code opening another turn of the same prompt (an `origin`
//   other than human: a task notification, an auto-continuation).
// - `interrupt`: the marker Claude Code leaves when a person stops a turn.
// - `tool-result`: a tool's answer echoed back.
// - `claude-code`: what passes between the person and Claude Code without
//   reaching Claude as input — what Claude Code writes on its own (`isMeta`: a
//   skill's expanded body, a command caveat; a compaction summary; a command's
//   output) and what a person addresses to Claude Code itself (a built-in
//   command such as `/clear` or `/model`, a `!` shell command).
export type UserEntry =
  | "prompt"
  | "turn"
  | "interrupt"
  | "tool-result"
  | "claude-code";

// [LAW:one-source-of-truth] Classified once, at the parse site, from the marks
// Claude Code writes — the message count, the response clock and the activity
// fold all read the one projected value.
export function userEntryOf(
  parsed: Record<string, unknown>,
): UserEntry | undefined {
  const msg = parsed.message as Record<string, unknown> | undefined;
  const messageType = parsed.type || msg?.role || msg?.type;
  if (messageType !== "user") return undefined;
  if (firstBlockType(msg) === "tool_result") return "tool-result";
  const origin =
    typeof parsed.origin === "object" && parsed.origin !== null
      ? (parsed.origin as { kind?: unknown }).kind
      : undefined;
  if (origin !== undefined && origin !== "human") return "turn";
  // Claude Code marks the rest only by the fixed text it writes. A skill
  // command, which Claude answers, leads with `<command-message>`; a built-in
  // command leads with `<command-name>`.
  const text = turnText(msg?.content).trimStart();
  if (text.startsWith("[Request interrupted by user")) return "interrupt";
  return parsed.isMeta === true ||
    parsed.isCompactSummary === true ||
    CLAUDE_CODE_TEXT.test(text)
    ? "claude-code"
    : "prompt";
}

const CLAUDE_CODE_TEXT =
  /^<(?:command-name|local-command-std(?:out|err)|bash-(?:input|stdout|stderr))>/;

// The first content block's `type`; the array (full LLM text) is never
// retained. Text content (a bare string) has no block type.
function firstBlockType(msg: Record<string, unknown> | undefined): unknown {
  const content = msg?.content;
  return Array.isArray(content) && typeof content[0] === "object" && content[0]
    ? (content[0] as { type?: unknown }).type
    : undefined;
}

// Build a ParsedEntry from a full parsed JSONL line, retaining only the
// fields actually used downstream. The full parsed object (which includes
// message.content arrays with complete LLM response text) is discarded so
// the GC can reclaim that memory promptly instead of pinning it via raw.
// [LAW:one-source-of-truth] All callers go through here; no second parse path.
function makeEntry(parsed: Record<string, unknown>): ParsedEntry | null {
  if (!parsed.timestamp) return null;
  const msg = parsed.message as Record<string, unknown> | undefined;
  const usage = msg?.usage as UsageCounts | undefined;
  const userEntry = userEntryOf(parsed);
  return {
    timestamp: new Date(parsed.timestamp as string),
    type: typeof parsed.type === "string" ? parsed.type : undefined,
    message: msg
      ? {
          id: typeof msg.id === "string" ? msg.id : undefined,
          model: typeof msg.model === "string" ? msg.model : undefined,
          usage,
          role: typeof msg.role === "string" ? msg.role : undefined,
          type: typeof msg.type === "string" ? msg.type : undefined,
        }
      : undefined,
    costUSD: typeof parsed.costUSD === "number" ? parsed.costUSD : undefined,
    isSidechain: parsed.isSidechain === true,
    userEntry,
    activity: entryActivity(parsed, userEntry),
    raw: {
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      message: msg
        ? {
            id: typeof msg.id === "string" ? msg.id : undefined,
            model: typeof msg.model === "string" ? msg.model : undefined,
            usage,
          }
        : undefined,
      requestId:
        typeof parsed.requestId === "string" ? parsed.requestId : undefined,
    },
  };
}

// [LAW:one-source-of-truth] The one reading of a transcript line: blank lines
// are none, and a line that is not a JSON object is `unparsed`. The bar's
// parse skips those lines; the doctor counts them (brandon-doctor-v62x.p4l),
// so the two agree on what a bad line is. Per line, so no reader holds more
// than one line's full object at once — makeEntry drops it straight away.
// [LAW:effects-at-boundaries] Pure: a reader that wants the reason logs it.
export type JsonLine =
  | { readonly kind: "blank" }
  | { readonly kind: "object"; readonly value: Record<string, unknown> }
  | { readonly kind: "unparsed"; readonly reason: string };

export function jsonLine(line: string): JsonLine {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "blank" };
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? { kind: "object", value: value as Record<string, unknown> }
      : { kind: "unparsed", reason: "not a JSON object" };
  } catch (parseError) {
    return { kind: "unparsed", reason: String(parseError) };
  }
}

// The entry one line contributes, if any — the step every parse loop takes.
function entryOf(line: string): ParsedEntry | null {
  const read = jsonLine(line);
  if (read.kind === "unparsed") {
    debug(`Failed to parse JSONL line: ${read.reason}`);
    return null;
  }
  if (read.kind === "blank") return null;
  // A projection that throws on one odd line skips that line, as a parse
  // failure does, rather than losing the whole transcript.
  try {
    return makeEntry(read.value);
  } catch (projectionError) {
    debug(`Failed to project JSONL line: ${projectionError}`);
    return null;
  }
}

// [LAW:one-source-of-truth] The one line→entry loop over text in hand: every
// window foldAppended reads goes through here.
function parseJsonlLines(text: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  for (const line of text.split("\n")) {
    const entry = entryOf(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

// A byte cursor into an append-only transcript: the offset consumed through the
// last complete line, the stamp observed at that read, and the inode. The store
// keys its per-file fold by this — `offset` bounds the next read to only what's
// new; `stamp` lets an unchanged file skip the read entirely; `ino` detects a
// rewrite (a rename-based /compact swaps the inode) so the fold resets instead
// of splicing new bytes onto a stale prefix.
export interface TranscriptCursor {
  readonly offset: number;
  readonly stamp: string;
  readonly ino: number;
}

// A line longer than FOLD_WINDOW_BYTES that a read took whole: the one thing
// that can still make a read hold more than a window.
export interface LongLine {
  readonly path: string;
  readonly offset: number;
  readonly bytes: number;
}

function longLinesWith(
  longLines: readonly LongLine[],
  path: string,
  read: WholeLines,
): readonly LongLine[] {
  return read.longLine === 0
    ? longLines
    : [...longLines, { path, offset: read.start, bytes: read.longLine }];
}

// [LAW:nothing-unseen] The daemon.log line each long line earns, for the
// caller to write through its own sink.
// [LAW:effects-at-boundaries] Pure: the caller owns the log effect.
export function longLineLog(longLines: readonly LongLine[]): string[] {
  return longLines.map(
    (l) =>
      `transcript long line path=${JSON.stringify(l.path)} offset=${l.offset} bytes=${l.bytes}`,
  );
}

// A fold of one transcript as its consumer keeps it: the value, and the
// cursor through the bytes that value has folded. [LAW:one-source-of-truth]
// The one pair every consumer stores, so a cursor and the fold it marks
// cannot be kept apart.
export interface Folded<S> {
  readonly cursor: TranscriptCursor;
  readonly value: S;
}

// [LAW:dataflow-not-control-flow][LAW:one-source-of-truth] Fold the entries
// appended to an append-only transcript since `prior` into `prior.value` (into
// `empty` when there is no prior), one window at a time: each window's
// entries are folded by `step` and dropped before the next is read, so a fold
// holds one window, never the file (brandon-unfiled-3248.bfnj). A cold fold
// is the same path from offset 0; a warm one costs O(bytes appended).
//
// The fold ends at the size the first window's stat saw — every later read
// is capped there — so a file growing faster than it is read cannot hold it
// here, and the cursor carries exactly the stamp of the bytes it folded; the
// rest is the next fold's. A partial trailing line waits for its newline.
//
// A window that reports `reset` (a /compact rewrite, a truncation) starts the
// fold over from `empty`, capped at its own stat. Absent and failed pass
// straight through.
export async function foldAppended<S>(
  filePath: string,
  prior: Folded<S> | undefined,
  empty: S,
  step: (state: S, entries: readonly ParsedEntry[]) => S | Promise<S>,
): Promise<Outcome<{ folded: Folded<S>; longLines: readonly LongLine[] }>> {
  let longLines: readonly LongLine[] = [];
  let cursor = prior?.cursor;
  let value = prior?.value ?? empty;
  let end: { size: number; stamp: string } | undefined;
  for (;;) {
    const read = await readAppended(
      filePath,
      cursor === undefined
        ? undefined
        : { offset: cursor.offset, ino: cursor.ino },
      end?.size,
    );
    if (read.kind !== "ok") return read;
    const window = read.value;
    // A reset discards what was folded, the long lines read for it included.
    if (window.reset) value = empty;
    longLines = longLinesWith(window.reset ? [] : longLines, filePath, window);
    if (end === undefined || window.reset) {
      end = { size: window.size, stamp: window.stamp };
    }
    const next = window.start + window.lines.length;
    // Decoded, and the window given back, before `step` can await — and
    // passed straight in, never named: a name holds this window's entries in
    // the fold's frame across the next read's I/O wait, where they are
    // promoted to the old generation (eight concurrent cold folds of a 29 MB
    // transcript: +120 MB RSS against +30 MB).
    value = await step(
      value,
      decodeLines(window, (b) => parseJsonlLines(b.toString("utf-8"))),
    );
    cursor = {
      offset: next,
      stamp: end.stamp,
      ino: window.ino,
    };
    if (window.atEnd) return ok({ folded: { cursor, value }, longLines });
  }
}
