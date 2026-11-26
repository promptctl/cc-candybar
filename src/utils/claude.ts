import type { CheckoutLocation } from "./git-root.js";
import { existsSync } from "node:fs";
// [LAW:single-enforcer] readdir and the forward read come from the gated
// transcript-fs owner, not node:fs/promises — the in-flight-I/O bound lives at
// one seam.
import { readAppendedText, readdir, type WholeLines } from "./transcript-fs";
import { join } from "node:path";
import { failed, ok, type Failed, type Ok, type Outcome } from "./outcome";
import type { DroppedLines, TranscriptLoss } from "./transcript-loss";
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
    // renders) and checks its kind when present; composePayload's
    // workspace normalization reads absence as none added.
    added_dirs?: string[];
    // Absent when not inside a linked git worktree
    git_worktree?: string;
  };

  // The daemon's, never Claude Code's: read once per request from the checkout.
  location?: CheckoutLocation;

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

// [LAW:types-are-the-program] A render can omit the current directory. The
// host supplies it from the client's cwd before handing it to a renderer.
export type RenderHookData = Omit<ClaudeHookData, "workspace"> & {
  readonly workspace: Omit<ClaudeHookData["workspace"], "current_dir"> & {
    readonly current_dir?: string;
  };
};

// The directories a session's Claude Code keeps its transcripts under:
// the one its client detected (the `claudeConfigDir` hint), else the two
// default locations that exist.
//
// [LAW:single-enforcer] The directory is the client's to report
// (detectClaudeConfigDir, src/claude-settings.ts): this runs in the detached
// daemon, whose own CLAUDE_CONFIG_DIR answers for whichever session spawned it.
export function getClaudePaths(
  detected: string | undefined,
  homeDir: string,
): string[] {
  if (detected !== undefined) return [detected];
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

// The sidechains a session's usage folds, the long lines their first-line
// reads met, and each sidechain whose first line cannot say whose it is.
export interface AgentTranscripts {
  readonly paths: readonly string[];
  readonly longLines: readonly LongLine[];
  readonly unowned: readonly TranscriptLoss[];
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
): Promise<Ok<AgentTranscripts> | Failed> {
  const paths: string[] = [];
  const unowned: TranscriptLoss[] = [];
  let longLines: readonly LongLine[] = [];

  const subagentsDir = join(projectPath, sessionId, "subagents");

  // [LAW:no-silent-failure] A session with no sidechains has no directory, so
  // none is no sidechains; one that cannot be listed fails the fold, as every
  // transcript the fold has to read and cannot does.
  let files: string[] | undefined;
  try {
    files = await unlessGone(readdir(subagentsDir));
  } catch (error) {
    return failed(
      `readdir ${subagentsDir}: ${error instanceof Error ? error.message : String(error)}`,
      "read",
    );
  }
  const agentFileNames = (files ?? []).filter(
    (f) => f.startsWith("agent-") && f.endsWith(".jsonl"),
  );

  for (const fileName of agentFileNames) {
    const filePath = join(subagentsDir, fileName);
    if (verified?.has(filePath)) {
      paths.push(filePath);
      continue;
    }
    // The first line only: one forward read from the file start (a file with
    // no complete line yet is read again next time).
    const read = await readAppendedText(filePath, undefined, undefined);
    // [LAW:no-silent-failure] A sidechain gone since the listing is one the
    // listing would not have named; one that cannot be read fails the fold.
    if (read.kind === "absent") continue;
    if (read.kind === "failed") return read;
    longLines = longLinesWith(longLines, filePath, read.value);
    const owner = sidechainOwnerOf(read.value.text, sessionId);
    switch (owner.kind) {
      case "this-session":
        paths.push(filePath);
        break;
      case "unknown":
        unowned.push({
          kind: "unowned-sidechain",
          path: filePath,
          reason: owner.reason,
        });
        break;
      // [LAW:dataflow-not-control-flow] Another session's file is none of
      // this one's; one with no whole line yet is checked by the next fold.
      case "another-session":
      case "unwritten":
        break;
    }
  }

  return ok({ paths, longLines, unowned });
}

// [LAW:types-are-the-program] Whose a sidechain is, by its first line: this
// session's, another's, not yet known because no whole line is written, or
// unknown because the line cannot say (`reason` says what the line is).
type SidechainOwner =
  | { readonly kind: "this-session" }
  | { readonly kind: "another-session" }
  | { readonly kind: "unwritten" }
  | { readonly kind: "unknown"; readonly reason: string };

// [LAW:parse-dont-validate] `text` is whole lines from the file's start.
function sidechainOwnerOf(text: string, sessionId: string): SidechainOwner {
  const end = text.indexOf("\n");
  if (end < 0) return { kind: "unwritten" };
  const line = jsonLine(text.slice(0, end));
  switch (line.kind) {
    case "blank":
      return { kind: "unknown", reason: "is blank" };
    case "unparsed":
      return { kind: "unknown", reason: line.reason };
    case "object": {
      const owner = line.value.sessionId;
      if (typeof owner !== "string")
        return { kind: "unknown", reason: "names no session" };
      return owner === sessionId
        ? { kind: "this-session" }
        : { kind: "another-session" };
    }
  }
}

// [LAW:types-are-the-program] exception: kept as type-aliases (not
// interfaces) so they're structurally assignable to `Record<string,
// unknown>` at the `extractModelId` boundary in daemon/cache/pricing.ts.
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
    // Why an assistant message stopped: `tool_use` while its turn goes on.
    stopReason?: string;
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

// The stop reasons that leave Claude working on its turn: a tool call, and the
// server pausing a long turn. A block of a message still streaming states
// none. Any other reason ends the turn, one the API adds later included, so
// an unknown stop ends a rate rather than holding it.
const TURN_GOES_ON: ReadonlySet<string | undefined> = new Set([
  undefined,
  "tool_use",
  "pause_turn",
]);

// [LAW:one-source-of-truth] Whether the session's turn is open after `entry`:
// input Claude answers opens one, an interrupt or a final assistant message
// ends it, and everything else (a tool's answer, what Claude Code writes on
// its own, a subagent's sidechain) leaves it as it was.
export function turnOpenAfter(open: boolean, entry: ParsedEntry): boolean {
  if (entry.isSidechain) return open;
  switch (entry.userEntry) {
    case "prompt":
    case "turn":
      return true;
    case "interrupt":
      return false;
    case "tool-result":
    case "claude-code":
      return open;
    case undefined:
      return entry.type === "assistant"
        ? TURN_GOES_ON.has(entry.message?.stopReason)
        : open;
  }
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

// [LAW:types-are-the-program] What one line gives a fold: its entry; nothing,
// for a blank line or a record of Claude Code's own with no timestamp and no
// message (a title, a mode, a snapshot), since a fold reads a line only for
// its time and its message; or a line the folds drop, and why (`reason` says
// what the line is: "is not JSON (…)").
export type LineRead =
  | { readonly kind: "entry"; readonly entry: ParsedEntry }
  | { readonly kind: "none" }
  | { readonly kind: "dropped"; readonly reason: string };

const NO_ENTRY: LineRead = { kind: "none" };
const dropped = (reason: string): LineRead => ({ kind: "dropped", reason });

// The token counts the folds read off a message's usage.
const USAGE_COUNTS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

// [LAW:parse-dont-validate] A message's usage as the folds read it: none,
// when it writes no count (no usage, a null one, or one with none of the
// counts), since a fold counts a response only for the tokens it gives; its
// counts; or malformed, when a count it gives is not a number.
type Usage =
  | { readonly kind: "none" }
  | { readonly kind: "counts"; readonly counts: UsageCounts }
  | { readonly kind: "malformed" };

const NO_USAGE: Usage = { kind: "none" };

function usageOf(usage: unknown): Usage {
  if (usage === undefined || usage === null) return NO_USAGE;
  if (typeof usage !== "object" || Array.isArray(usage))
    return { kind: "malformed" };
  const given = usage as Record<string, unknown>;
  const counts: UsageCounts = {};
  for (const key of USAGE_COUNTS) {
    const count = given[key];
    if (count === undefined || count === null) continue;
    if (typeof count !== "number" || !Number.isFinite(count))
      return { kind: "malformed" };
    counts[key] = count;
  }
  return Object.keys(counts).length === 0
    ? NO_USAGE
    : { kind: "counts", counts };
}

// [LAW:parse-dont-validate] The one parse of a line's object into the entry
// the folds read, keeping only the fields they use: the full object (whose
// message.content arrays hold complete LLM response text) is dropped straight
// away, so the GC reclaims it instead of pinning it via raw. A line whose
// usage or timestamp the folds cannot read is dropped, never an entry the
// folds count wrongly or silently skip.
// [LAW:one-source-of-truth] All callers go through here; no second parse path.
function entryOf(parsed: Record<string, unknown>): LineRead {
  const message = parsed.message;
  const msg =
    typeof message === "object" && message !== null && !Array.isArray(message)
      ? (message as Record<string, unknown>)
      : undefined;
  const read = usageOf(msg?.usage);
  if (read.kind === "malformed")
    return dropped("has usage whose counts are not numbers");
  const usage = read.kind === "counts" ? read.counts : undefined;
  // A JSON writer spells an absent field as null as readily as by leaving it
  // out, so either is no timestamp.
  if (parsed.timestamp === undefined || parsed.timestamp === null)
    return msg === undefined
      ? NO_ENTRY
      : dropped("is a message with no timestamp");
  const timestamp =
    typeof parsed.timestamp === "string"
      ? new Date(parsed.timestamp)
      : undefined;
  if (timestamp === undefined || Number.isNaN(timestamp.getTime()))
    return dropped("has a timestamp that is not a date");
  const userEntry = userEntryOf(parsed);
  return {
    kind: "entry",
    entry: {
      timestamp,
      type: typeof parsed.type === "string" ? parsed.type : undefined,
      message: msg
        ? {
            id: typeof msg.id === "string" ? msg.id : undefined,
            model: typeof msg.model === "string" ? msg.model : undefined,
            usage,
            role: typeof msg.role === "string" ? msg.role : undefined,
            type: typeof msg.type === "string" ? msg.type : undefined,
            stopReason:
              typeof msg.stop_reason === "string" ? msg.stop_reason : undefined,
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
    },
  };
}

// [LAW:one-source-of-truth] The one JSON reading of a transcript line: blank
// lines are none, and a line that is not a JSON object is `unparsed`.
// Per line, so no reader holds more than one line's full object at once —
// the entry parse drops it straight away. `reason` says what the line is.
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
      : { kind: "unparsed", reason: "is not a JSON object" };
  } catch (parseError) {
    return {
      kind: "unparsed",
      reason: `is not JSON (${parseError instanceof Error ? parseError.message : String(parseError)})`,
    };
  }
}

// [LAW:one-source-of-truth] The one reading of a transcript line: every fold
// and the cache timer's tail scan read a line through here. A projection
// that throws is a defect of the daemon's own, not of the line, so it goes
// up as the fold's fault rather than counting as a line dropped.
export function lineOf(line: string): LineRead {
  const read = jsonLine(line);
  switch (read.kind) {
    case "blank":
      return NO_ENTRY;
    case "unparsed":
      return dropped(read.reason);
    case "object":
      return entryOf(read.value);
  }
}

// What a window's lines gave a fold: their entries, how many lines the
// window held, and the fold's dropped lines with the window's own counted in.
interface WindowLines {
  readonly entries: readonly ParsedEntry[];
  readonly lines: number;
  readonly dropped: DroppedLines | null;
}

// [LAW:one-source-of-truth] The one line→entry loop over text in hand: every
// window foldAppended reads goes through here. `text` is whole lines, the
// first of them line `after + 1` of its file; `dropped` is what the fold had
// dropped before them.
function parseJsonlLines(
  text: string,
  after: number,
  dropped: DroppedLines | null,
): WindowLines {
  const entries: ParsedEntry[] = [];
  // Whole lines end in a newline, so the last piece is the empty rest.
  const lines = text.split("\n");
  let lost = dropped;
  for (const [index, line] of lines.entries()) {
    const read = lineOf(line);
    switch (read.kind) {
      case "entry":
        entries.push(read.entry);
        break;
      case "dropped":
        lost =
          lost === null
            ? { lines: 1, firstLine: after + index + 1, reason: read.reason }
            : { ...lost, lines: lost.lines + 1 };
        break;
      case "none":
        break;
    }
  }
  return { entries, lines: lines.length - 1, dropped: lost };
}

// A byte cursor into an append-only transcript: the offset consumed through the
// last complete line, how many lines that is, the stamp observed at that read,
// and the inode. The store
// keys its per-file fold by this — `offset` bounds the next read to only what's
// new; `stamp` lets an unchanged file skip the read entirely; `ino` detects a
// rewrite (a rename-based /compact swaps the inode) so the fold resets instead
// of splicing new bytes onto a stale prefix.
export interface TranscriptCursor {
  readonly offset: number;
  readonly line: number;
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
  read: Pick<WholeLines, "longLine" | "start">,
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

// A fold of one transcript as its consumer keeps it: the value, the cursor
// through the bytes that value has folded, and the lines among them it could
// not read. [LAW:one-source-of-truth] The one record every consumer stores,
// so a cursor, the fold it marks and what that fold is missing cannot be kept
// apart.
export interface Folded<S> {
  readonly cursor: TranscriptCursor;
  readonly value: S;
  readonly dropped: DroppedLines | null;
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
  let folded = prior;
  let end: { size: number; stamp: string } | undefined;
  for (;;) {
    const read = await readAppendedText(
      filePath,
      folded === undefined
        ? undefined
        : { offset: folded.cursor.offset, ino: folded.cursor.ino },
      end?.size,
    );
    if (read.kind !== "ok") return read;
    const window = read.value;
    // [LAW:one-source-of-truth] What this window folds onto: the fold so far,
    // or — on a first read, or a reset, which discards the fold whole in one
    // step — the file's start, as a first read folds it. The long lines read
    // for a discarded fold go with it.
    const from =
      window.reset || folded === undefined
        ? { line: 0, value: empty, dropped: null }
        : {
            line: folded.cursor.line,
            value: folded.value,
            dropped: folded.dropped,
          };
    longLines = longLinesWith(window.reset ? [] : longLines, filePath, window);
    if (end === undefined || window.reset) {
      end = { size: window.size, stamp: window.stamp };
    }
    // Destructured, so the fold does not hold the entries across the next
    // window's I/O.
    const { entries, lines, dropped } = parseJsonlLines(
      window.text,
      from.line,
      from.dropped,
    );
    folded = {
      cursor: {
        offset: window.start + window.bytes,
        line: from.line + lines,
        stamp: end.stamp,
        ino: window.ino,
      },
      value: await step(from.value, entries),
      dropped,
    };
    if (window.atEnd) return ok({ folded, longLines });
  }
}
