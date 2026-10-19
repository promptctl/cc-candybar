// [LAW:one-source-of-truth] Source kinds are the bridge between external
// data (render payload, environment, static config) and the VariableStore.
// All payload ingestion goes through applyInput — there is no other path
// that writes input-kind boxes during a render.
//
// Two concerns deliberately separated:
// - VariableStore: reactivity primitives (boxes, computeds, MobX scheduling)
// - SourceRegistry: source-kind semantics (path resolution, fallback chain,
//   last_error tracking)

import { launch } from "../proc/launch";
import { debug } from "../utils/logger";
import { readFile as fsReadFile } from "fs/promises";
import { watch as fsWatch, type FSWatcher } from "fs";
import { realpathSync, statSync } from "fs";
import path from "path";
import { nearestWatchTarget } from "../utils/watch-target.js";
import { setInterval, clearInterval } from "timers";
import { observable, reaction, type IReactionDisposer } from "mobx";
import { ColorDepth } from "@promptctl/rich-js";
import {
  typeOf,
  toString,
  toNumber,
  toBool,
  type VarType,
  type VarValue,
} from "./types.js";
import type { VariableStore } from "./store.js";
import { createCcCandybarEngine } from "../template-engine/engine.js";
import { buildScope } from "../template-engine/scope.js";
import { GitDataProvider } from "../daemon/cache/git.js";
import type { GitInfo } from "../segments/git.js";
import { ok, failed, orElse, ABSENT, type Outcome } from "../utils/outcome.js";
import {
  jsonParser,
  regexParser,
  textParser,
  type Parser,
  type SourceParse,
} from "./parse.js";
import { AbsentValueError, readAbsentValue, type JsonValue } from "./types.js";
import type { SessionStateReader } from "../daemon/session-state.js";
import { TrailingEdge } from "../utils/trailing-edge.js";
import { dateOf, type Instant } from "../utils/instant.js";

// How long text that is not a document may be a write still in progress
// before it shows as the failure it is (documentPublisher).
export const TORN_WRITE_SETTLE_MS = 250;

// ─── CachePolicy ─────────────────────────────────────────────────────────────

// [LAW:one-type-per-behavior] One discriminated union covers all cache policies.
// The config layer normalises external string representations (e.g. ttl:"5s")
// before calling declareShell / declareFile.
export type CachePolicy =
  | { readonly kind: "ttl"; readonly durationMs: number }
  | { readonly kind: "watch_file"; readonly path: string }
  | { readonly kind: "key"; readonly template: string }
  | { readonly kind: "depends_on"; readonly varNames: readonly string[] }
  | { readonly kind: "never" };

// [LAW:single-enforcer] Minimum allowed TTL for user-shell sources. User
// config can request shorter values; declareShell clamps to this floor and
// emits a debug warning. The floor exists to prevent unbounded subprocess
// churn from a misconfigured `ttl: 50ms` against a 200ms command (which would
// silently overlap and stack up). [LAW:no-mode-explosion] not a config knob.
export const MIN_SHELL_TTL_MS = 500;

// [LAW:single-enforcer] Apply the shell-source TTL floor at declare-time.
// If the policy is anything other than `ttl`, the input is returned unchanged
// — the floor only applies to time-driven shell refresh. If `ttl.durationMs`
// is already at or above MIN_SHELL_TTL_MS, the input is returned unchanged.
// [LAW:dataflow-not-control-flow] Same code path every call; the result is a
// function of the input policy + floor constant.
function clampShellCache(name: string, policy: CachePolicy): CachePolicy {
  if (policy.kind !== "ttl") return policy;
  if (policy.durationMs >= MIN_SHELL_TTL_MS) return policy;
  debug(
    `declareShell "${name}": ttl ${policy.durationMs}ms below floor ${MIN_SHELL_TTL_MS}ms; clamping`,
  );
  return { kind: "ttl", durationMs: MIN_SHELL_TTL_MS };
}

// Parse a duration string to milliseconds.  Accepted units: ms, s, m, h.
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(s);
  if (!m) throw new RangeError(`Invalid duration: "${s}"`);
  const v = parseFloat(m[1]!);
  switch (m[2]) {
    case "ms":
      return v;
    case "s":
      return v * 1_000;
    case "m":
      return v * 60_000;
    case "h":
      return v * 3_600_000;
    default:
      throw new RangeError(`Unexpected duration unit: "${m[2]}"`);
  }
}

// ─── Source-kind option bags ──────────────────────────────────────────────────

// [LAW:decomposition] A user source is a READER (what text arrives: a
// command's stdout, a file's content or first line) and a PARSER (what value
// that text becomes — see parse.ts). The two are orthogonal data: shell and
// file differ only in reader; text/regex/json differ only in parser; every
// combination means what it says. The fallback lives in the parser arm, in
// that arm's output domain.
export interface ShellOptions {
  // [LAW:types-are-the-program] Where the command runs: the render entry's
  // cwd, like GitOptions.cwd. Required, because the daemon is detached — its
  // own cwd is whichever shell spawned it, never the session's.
  readonly cwd: string;
  readonly cache: CachePolicy;
  readonly parse: SourceParse;
}

export type ReadMode = "whole" | "first-line";

export interface FileOptions {
  // What text the file yields to the parser: its whole content (default) or
  // its first line.
  readonly readMode?: ReadMode;
  readonly cache: CachePolicy;
  readonly parse: SourceParse;
}

export interface TemplateOptions {
  readonly varDefault?: string;
}

export interface TimeOptions {
  // Go reference-time layout string (e.g. "15:04:05", "2006-01-02").
  // Reference time: Mon Jan 2 15:04:05 MST 2006
  readonly format: string;
  readonly varDefault?: string;
}

// [LAW:one-type-per-behavior] Six git fields — each has a fixed inferred type.
// branch/sha are strings; dirty is boolean; ahead/behind/stash are numbers.
export type GitField =
  | "branch"
  | "sha"
  | "dirty"
  | "ahead"
  | "behind"
  | "stash";

export interface GitOptions {
  readonly field: GitField;
  // Working directory whose git repo to query.  Resolved at declaration time.
  readonly cwd: string;
  readonly varDefault?: VarValue;
}

// [LAW:one-source-of-truth] state vars read through to SessionState; the
// reactive contract is owned by SessionState's internal atom. The computed
// reads the canonical session-id variable (SESSION_ID_VAR_NAME) and
// dispatches through SessionStateReader.get.
export interface StateOptions {
  readonly key: string;
  readonly varDefault?: string;
}

// [LAW:one-source-of-truth] The conventional name DSL configs use for the
// hook payload's session_id input variable. State-kind variables resolve
// "which session am I in" from this name — no per-decl override.
// [LAW:no-mode-explosion] One axis of variability less; configs cannot
// drift on which variable carries the session id.
export const SESSION_ID_VAR_NAME = "session.id";

// ─── Private infrastructure ───────────────────────────────────────────────────

// [LAW:effects-at-boundaries] A reader is the effect half of a source: it
// performs the read and classifies its own failure (a non-zero exit, an
// unreadable file) as a value. `where` names the text's origin for the
// parser's failure message ("regex no-match in output of \"uptime\"").
// A read the registry cancelled (`signal`, fired by dispose) is not a value
// the source yielded: it rejects with the signal's reason, which is the one
// rejection the pipeline expects.
interface SourceReader {
  readonly where: string;
  read(): Promise<Outcome<string>>;
}

function shellReader(
  command: string,
  cwd: string,
  signal: AbortSignal,
): SourceReader {
  return {
    // The directory is part of the origin: a command that asks about "this
    // repo" answers differently per session, so every failure — exit, regex
    // no-match, JSON parse — names where it ran.
    where: `output of "${command}" in ${cwd}`,
    read: async () => {
      const r = await launch({
        bin: "/bin/sh",
        args: ["-c", command],
        cwd,
        category: "user-shell",
        signal,
      });
      if (!r.ok && r.reason === "aborted") throw signal.reason;
      if (r.ok) return ok(r.stdout);
      const why =
        r.exitCode === null
          ? [r.reason, r.error].filter((s) => s !== undefined).join(": ")
          : `exited with code ${r.exitCode}`;
      return failed(`shell "${command}" ${why} in ${cwd}`);
    },
  };
}

function fileReader(
  filePath: string,
  readMode: ReadMode,
  signal: AbortSignal,
): SourceReader {
  return {
    where: `"${filePath}"`,
    read: async () => {
      try {
        const raw = await fsReadFile(filePath, { encoding: "utf8", signal });
        return ok(
          readMode === "first-line" ? (raw.split(/\r?\n/)[0] ?? "") : raw,
        );
      } catch {
        if (signal.aborted) throw signal.reason;
        return failed(`file unreadable: ${filePath}`);
      }
    },
  };
}

// The parse step over a read's outcome: a failed read passes through
// untouched (it already names its origin); a failed parse gains the origin.
function parsed<V>(
  read: Outcome<string>,
  parser: Parser<V>,
  where: string,
): Outcome<V> {
  if (read.kind !== "ok") return read;
  const out = parser(read.value);
  return out.kind === "failed" ? failed(`${out.reason} in ${where}`) : out;
}

// The publish half of a source, closed over its store node: takes what the
// reader yielded, parses it, and writes the node — value or fallback.
type Publish = (read: Outcome<string>) => void;

// ─── Go reference-time formatter ─────────────────────────────────────────────

const MONTHS_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const WEEKDAYS_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const WEEKDAYS_SHORT = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

// [LAW:single-enforcer] One Go-reference-time formatter shared by all time
// source kinds.  Tokens are matched longest-first in a single left-to-right
// pass so overlapping prefixes ("January" before "Jan") never conflict.
//
// Reference time components:
//   2006 → 4-digit year       06 → 2-digit year
//   January / Jan → month     01 → 2-digit month   1 → 1/2-digit month
//   Monday / Mon → weekday
//   02 → 2-digit day          2 → 1/2-digit day
//   15 → 24h hour (00-23)     3 → 12h hour (1-12)
//   04 → 2-digit minute       4 → minute
//   05 → 2-digit second       5 → second
//   PM / pm → AM/PM marker
export function formatGoTime(layout: string, d: Date): string {
  type Token = readonly [string, (d: Date) => string];
  const tokens: readonly Token[] = [
    ["2006", (d) => String(d.getFullYear())],
    ["January", (d) => MONTHS_FULL[d.getMonth()]!],
    ["Monday", (d) => WEEKDAYS_FULL[d.getDay()]!],
    ["Jan", (d) => MONTHS_SHORT[d.getMonth()]!],
    ["Mon", (d) => WEEKDAYS_SHORT[d.getDay()]!],
    ["15", (d) => String(d.getHours()).padStart(2, "0")],
    ["06", (d) => String(d.getFullYear() % 100).padStart(2, "0")],
    ["01", (d) => String(d.getMonth() + 1).padStart(2, "0")],
    ["02", (d) => String(d.getDate()).padStart(2, "0")],
    ["04", (d) => String(d.getMinutes()).padStart(2, "0")],
    ["05", (d) => String(d.getSeconds()).padStart(2, "0")],
    ["PM", (d) => (d.getHours() < 12 ? "AM" : "PM")],
    ["pm", (d) => (d.getHours() < 12 ? "am" : "pm")],
    ["1", (d) => String(d.getMonth() + 1)],
    ["2", (d) => String(d.getDate())],
    ["3", (d) => String(d.getHours() % 12 || 12)],
    ["4", (d) => String(d.getMinutes())],
    ["5", (d) => String(d.getSeconds())],
  ];

  let result = "";
  let i = 0;
  while (i < layout.length) {
    let consumed = false;
    for (const [token, fn] of tokens) {
      if (layout.startsWith(token, i)) {
        result += fn(d);
        i += token.length;
        consumed = true;
        break;
      }
    }
    if (!consumed) {
      result += layout[i];
      i++;
    }
  }
  return result;
}

// ─── Git helpers ─────────────────────────────────────────────────────────────

// [LAW:one-source-of-truth] One type map; the field discriminator determines
// the box type at declaration time — no runtime coercion needed.
const GIT_FIELD_TYPE: Readonly<Record<GitField, VarType>> = {
  branch: "string",
  sha: "string",
  dirty: "boolean",
  ahead: "number",
  behind: "number",
  stash: "number",
};

// [LAW:one-source-of-truth] Git data flows through GitDataProvider. The
// projection below is the only mapping from GitInfo (segments' shape) to
// var-system's six-field model. Pre-kz8.3 var-system maintained its own
// parallel fleet (execGit + fetchGitSnapshot + GitPoller + WatchManager
// subscriptions); the provider now owns the cache, the watcher, and the
// single launch category "git".

// Project a GitInfo snapshot down to a single var-system GitField value.
// Returns the typed fallback when info is null (not a repo or unresolved).
function projectGitField(
  info: GitInfo | null,
  field: GitField,
  varDefault: VarValue | undefined,
  defaultEmptyValue: VarValue,
): VarValue {
  if (info === null) {
    if (varDefault !== undefined) return varDefault;
    const type = GIT_FIELD_TYPE[field];
    try {
      return coerceToType(defaultEmptyValue, type);
    } catch {
      return zeroValue(type);
    }
  }
  switch (field) {
    case "branch":
      // GitService emits the literal "detached" when HEAD is not on a
      // branch; var-system's prior contract was empty string in that case.
      // (Caveat: a branch literally named "detached" would also map to "" —
      // preserving the pre-kz8.3 behavior, which had the same ambiguity in
      // a different shape.)
      return info.branch === "detached" ? "" : info.branch;
    // [LAW:dataflow-not-control-flow] Outcome fields fold via orElse: this
    // surface only renders values, so absent and failed both collapse to the
    // typed zero (the provider's delivery edge already logged any failure).
    case "sha":
      return orElse(info.sha, "");
    case "dirty":
      return info.status !== "clean";
    case "ahead":
      return orElse(info.aheadBehind, { ahead: 0, behind: 0 }).ahead;
    case "behind":
      return orElse(info.aheadBehind, { ahead: 0, behind: 0 }).behind;
    case "stash":
      return orElse(info.stashCount, 0);
  }
}

// ─── WatchManager ─────────────────────────────────────────────────────────────

// [LAW:single-enforcer] One fs.watch handle per path regardless of subscriber
// count.  Multiple shell/file variables can share one watcher on the same path.
//
// A file is watched through its DIRECTORY, filtered to its name: a watch on
// the file itself binds its inode, so it never sees a file created after it
// (an app that has not written yet) and goes deaf after the first atomic
// rename (write-then-rename, the safe way to rewrite a file). A directory
// that does not exist yet is watched through its nearest existing ancestor
// (`nearestWatchTarget`), and each directory that appears re-arms the watch
// one level deeper.
function resolvedPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Absent: watched by name until it appears.
    return p;
  }
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    // Absent (or unreadable): watched as a file that may appear.
    return false;
  }
}

// What one subscription watches right now: the directory itself when the
// path is one, else the (dir, name) tuple of its nearest existing ancestor.
// `leaf` is true once the watch reaches the path's own directory — only then
// can an event be about the path itself.
interface WatchTarget {
  readonly dir: string;
  readonly name: string | null;
  readonly leaf: boolean;
}

function watchTargetOf(filePath: string): WatchTarget {
  // A symlink is followed: the writes land on its target.
  const target = resolvedPath(filePath);
  return isDirectory(target)
    ? { dir: target, name: null, leaf: true }
    : nearestWatchTarget(target);
}

const targetKey = (t: WatchTarget): string => `${t.dir}\0${t.name ?? ""}`;

// A watch the OS refused (ENOSPC on inotify, EMFILE, EACCES, the directory
// removed under the walk): reported to every subscriber, never thrown — a
// throw out of a watcher callback would take the daemon down.
type WatchFailed = (message: string) => void;

interface WatchEntry {
  // null while the OS refuses the watch; `failure` then says why.
  watcher: FSWatcher | null;
  failure: string;
  target: WatchTarget;
  // Each subscriber's update, and where its watch failures are recorded.
  readonly subscribers: Map<() => void, WatchFailed>;
}

class WatchManager {
  private readonly watchers = new Map<string, WatchEntry>();

  subscribe(
    filePath: string,
    callback: () => void,
    onFailed: WatchFailed,
  ): () => void {
    const entry = this.watchers.get(filePath) ?? this.arm(filePath);
    entry.subscribers.set(callback, onFailed);
    if (entry.watcher === null) onFailed(entry.failure);
    return () => this.unsubscribe(filePath, callback);
  }

  private arm(filePath: string): WatchEntry {
    const entry: WatchEntry = {
      watcher: null,
      failure: "",
      target: watchTargetOf(filePath),
      subscribers: new Map(),
    };
    entry.watcher = this.open(filePath, entry, entry.target);
    this.watchers.set(filePath, entry);
    return entry;
  }

  // An event under the watched ancestor may mean a missing directory
  // appeared (or the watched one vanished): re-derive the target ONCE, and
  // move the watch when it moved. The new watch opens before the old one
  // closes, so a refusal leaves the old watch listening for the next event.
  private rearm(filePath: string, entry: WatchEntry): void {
    const target = watchTargetOf(filePath);
    if (entry.watcher !== null && targetKey(target) === targetKey(entry.target))
      return;
    const watcher = this.open(filePath, entry, target);
    if (watcher === null) return;
    entry.watcher?.close();
    entry.watcher = watcher;
    entry.target = target;
  }

  private open(
    filePath: string,
    entry: WatchEntry,
    target: WatchTarget,
  ): FSWatcher | null {
    const { dir, name } = target;
    const self = path.basename(dir);
    try {
      return fsWatch(dir, (_event, changed) => {
        // A platform that reports no name could be reporting anything here.
        const aboutName = changed === null || name === null || changed === name;
        // The watched directory's own removal or rename reports its own name.
        if (!aboutName && changed !== self) return;
        const wasLeaf = entry.target.leaf;
        this.rearm(filePath, entry);
        // Ancestor churn on the way DOWN is not a change to the path; a move
        // up from the leaf is its removal, which the subscribers must read.
        if (!wasLeaf && !entry.target.leaf) return;
        for (const cb of entry.subscribers.keys()) cb();
      });
    } catch (e) {
      const message = `watch_file ${filePath}: cannot watch ${dir} — ${e instanceof Error ? e.message : String(e)}`;
      entry.failure = message;
      for (const report of entry.subscribers.values()) report(message);
      return null;
    }
  }

  private unsubscribe(filePath: string, callback: () => void): void {
    const entry = this.watchers.get(filePath);
    if (!entry) return;
    entry.subscribers.delete(callback);
    if (entry.subscribers.size === 0) {
      entry.watcher?.close();
      this.watchers.delete(filePath);
    }
  }

  dispose(): void {
    for (const { watcher } of this.watchers.values()) watcher?.close();
    this.watchers.clear();
  }

  size(): number {
    return this.watchers.size;
  }
}

// ─── TtlBucketManager ────────────────────────────────────────────────────────

// [LAW:single-enforcer] One setInterval per unique TTL duration, shared by all
// variables with that TTL.  Multiple variables at the same interval fire on
// one timer tick rather than N separate timers.
class TtlBucketManager {
  private readonly buckets = new Map<
    number,
    { timer: ReturnType<typeof setInterval>; callbacks: Set<() => void> }
  >();

  subscribe(durationMs: number, callback: () => void): () => void {
    let entry = this.buckets.get(durationMs);
    if (!entry) {
      const callbacks = new Set<() => void>();
      const timer = setInterval(() => {
        for (const cb of callbacks) cb();
      }, durationMs);
      entry = { timer, callbacks };
      this.buckets.set(durationMs, entry);
    }
    entry.callbacks.add(callback);
    return () => this.unsubscribe(durationMs, callback);
  }

  private unsubscribe(durationMs: number, callback: () => void): void {
    const entry = this.buckets.get(durationMs);
    if (!entry) return;
    entry.callbacks.delete(callback);
    if (entry.callbacks.size === 0) {
      clearInterval(entry.timer);
      this.buckets.delete(durationMs);
    }
  }

  dispose(): void {
    for (const { timer } of this.buckets.values()) clearInterval(timer);
    this.buckets.clear();
  }

  bucketCount(): number {
    return this.buckets.size;
  }
}

// ─── Shared metadata ──────────────────────────────────────────────────────────

export interface LastError {
  readonly timestamp: number; // Date.now() epoch ms
  readonly message: string;
}

interface InputMeta {
  readonly path: string;
  readonly varDefault: VarValue | undefined;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Recursively resolves a dotted path through a plain object.
// Returns undefined if any segment is absent or the traversed value is not an object.
function resolvePath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// Coerces an external primitive to a typed VarValue using the cast helpers
// from types.ts. Throws for non-primitive runtypes or impossible casts.
function coerceToType(raw: unknown, type: VarType): VarValue {
  // [LAW:no-defensive-null-guards] Trust-boundary check: payload values must be
  // primitives. Non-primitive means malformed input — fail loudly.
  if (
    typeof raw !== "string" &&
    typeof raw !== "number" &&
    typeof raw !== "boolean"
  ) {
    throw new TypeError(
      `Expected string|number|boolean from payload, got ${typeof raw}`,
    );
  }
  if (type === "string") return toString(raw);
  if (type === "number") return toNumber(raw);
  return toBool(raw);
}

// Type-appropriate zero used as the final backstop in the fallback chain when
// neither per-variable default nor defaultEmptyValue can be coerced.
function zeroValue(type: VarType): VarValue {
  if (type === "number") return 0;
  if (type === "boolean") return false;
  return "";
}

// ─── SourceRegistry ───────────────────────────────────────────────────────────

// [LAW:single-enforcer] One SourceRegistry per daemon, sharing one
// VariableStore. Multiple registries on the same store would produce
// duplicate box definitions for input-kind variables.

export class SourceRegistry {
  private readonly inputMetas = new Map<string, InputMeta>();
  private readonly lastErrors = new Map<string, LastError>();
  // A cache policy that cannot fire is a STANDING fault, not a read's
  // outcome: a read that succeeds afterwards says nothing about whether the
  // source will ever run again, so no read outcome clears it. A watch the OS
  // refused lives until the registry does; a key template that throws lives
  // until the key evaluates again. One map, since a variable has one policy.
  private readonly policyFaults = new Map<string, LastError>();

  // Triggers for shell/file cache policies and the time source's tick:
  private readonly watchMgr = new WatchManager();
  private readonly ttlMgr = new TtlBucketManager();
  // [LAW:single-enforcer] One subscription per cwd — every git variable
  // pointing at the same working directory shares one GitDataProvider
  // subscription, and the provider in turn shares one watcher + one cache
  // entry across N subscribers in the same repo.
  private readonly gitSubscriptions = new Map<
    string,
    {
      fieldSubs: Map<
        GitField,
        Array<{ name: string; varDefault: VarValue | undefined }>
      >;
      // The subscription's first delivery, kept because every field declared
      // for this cwd — including ones declared after the subscription was
      // opened — registers it as its own in-flight work. One promise, N names.
      firstDelivery: Promise<void>;
      unsubscribe: () => void;
    }
  >();
  // Collects all cleanup callbacks (TTL unsubscribes, watch unsubscribes,
  // MobX reaction disposers) so dispose() tears everything down in one call.
  private readonly cleanups: Array<() => void> = [];
  // [LAW:no-ambient-temporal-coupling] The in-flight run of each async
  // source, by name: one run per source at a time (a refresh that fires
  // while the previous run is still out is dropped), and `settled()` is the
  // explicit "every source has completed its current run" state a caller
  // (`cc-candybar check`) awaits instead of guessing a delay.
  private readonly inFlight = new Map<string, Promise<void>>();
  // [LAW:single-enforcer] Serializes each source's reads and remembers a trigger
  // that arrived mid-read, so a re-trigger re-reads once rather than starting a
  // parallel read or being dropped. Shared with the git cache's refresh path,
  // which had the same problem first — see src/utils/trailing-edge.ts.
  private readonly reads = new TrailingEdge();
  // [LAW:single-enforcer] The registry owns every async handle its sources
  // hold — timers, watchers, reactions, and the child processes and file
  // reads in flight. This is their cancellation: dispose() aborts it, so a
  // run cannot outlive the registry that started it (RenderCache's
  // dispose-before-swap contract reaches the children too).
  private readonly abort = new AbortController();
  // [LAW:one-source-of-truth] The depth the terminal draws the current render
  // at — the one clock every contrast floor reads, in this registry's variable
  // templates and in the render engine alike. Observable, because the depth is
  // a per-render fact (edit mode stages it over the config's own): a template
  // variable whose `readableOn` read it recomputes when it moves rather than
  // keeping the answer it measured at the previous depth.
  private readonly drawn = observable.box(ColorDepth.TRUECOLOR);
  readonly drawnAt = (): ColorDepth => this.drawn.get();
  // [LAW:one-source-of-truth] The instant the current render is drawn at — the
  // one clock every time read in a render reads: the datetime functions of this
  // registry's variable templates and of the render engine, and every `time`
  // variable. Observable for the depth's reason: a variable that read the time
  // recomputes when a later render moves it, and one that did not is untouched.
  // Absent until a render publishes one, and a read before then says so
  // [LAW:no-silent-failure]: there is no instant a render has not been given.
  private readonly instant = observable.box<Instant | null>(null);
  readonly now = (): Date => {
    const at = this.instant.get();
    if (at === null) {
      throw new Error(
        "the time was read before any render published its instant",
      );
    }
    return dateOf(at);
  };
  // Shared engine instance — parse() is expensive; the engine is reused for
  // all key: template compilations.
  // [LAW:one-source-of-truth] One engine per registry, not one per variable.
  private readonly engine = createCcCandybarEngine({
    clock: this.now,
    drawnAt: this.drawnAt,
  });

  private readonly gitProvider: GitDataProvider;
  private readonly ownsGitProvider: boolean;
  // [LAW:locality-or-seam] sessionState is injected (not constructed here)
  // so tests can substitute a fake and the daemon shares its singleton.
  // Absent in non-daemon contexts; declareState() rejects loudly in that case
  // rather than silently returning empty strings.
  private readonly sessionState: SessionStateReader | undefined;

  // defaultEmptyValue is the global fallback of last resort — the config-level
  // `default_empty_value` from the proposal. Defaults to empty string.
  //
  // gitProvider lets the daemon inject its shared instance; when omitted (e.g.
  // in tests, or pre-daemon-wired runtimes), a private one is constructed so
  // the registry remains self-contained.
  //
  // sessionState lets the daemon inject its singleton so state-kind variables
  // share one MobX atom and one disk-persistence layer with the click verbs.
  // Omitted in tests that don't exercise state vars.
  constructor(
    private readonly store: VariableStore,
    private readonly defaultEmptyValue: VarValue = "",
    gitProvider?: GitDataProvider,
    sessionState?: SessionStateReader,
  ) {
    if (gitProvider) {
      this.gitProvider = gitProvider;
      this.ownsGitProvider = false;
    } else {
      this.gitProvider = new GitDataProvider({ sanityIntervalMs: 0 });
      this.ownsGitProvider = true;
    }
    this.sessionState = sessionState;
  }

  // [LAW:one-source-of-truth] The registry IS the owner of its store — every
  // variable it declares lives there, and the renderer reads back through it.
  // Exposing it read-only lets a caller that already holds the registry obtain
  // the one store without threading a second reference that could diverge (the
  // action runtime reads session.id/current values from this exact store).
  get variableStore(): VariableStore {
    return this.store;
  }

  // ─── Synchronous source kinds ─────────────────────────────────────────────

  // literal: type inferred from value; box written once at declaration and never again.
  declareLiteral(name: string, value: VarValue): void {
    this.store.defineBox(name, typeOf(value), value);
  }

  // A document that is a known failure for as long as it is declared.
  declareFailedDocument(name: string, reason: string): void {
    this.store.defineDocument(name, failed(reason));
  }

  // input: per-render box; initial value from fallback chain (path not yet resolved).
  // At each render, applyInput resolves path against the payload and updates the box.
  declareInput(
    name: string,
    path: string,
    type: VarType,
    varDefault?: VarValue,
  ): void {
    // [LAW:dataflow-not-control-flow] Initialize to the fallback value so the
    // box always holds a valid typed value — even before the first render push.
    const initial =
      varDefault !== undefined ? varDefault : this.defaultFor(type);
    this.store.defineBox(name, type, initial);
    this.inputMetas.set(name, { path, varDefault });
  }

  // env: resolved once at declaration from process.env; box written once, never again.
  // type is always 'string' — env vars are text by nature.
  declareEnv(name: string, envVar: string, varDefault?: string): void {
    const raw = process.env[envVar];
    if (raw !== undefined) {
      this.store.defineBox(name, "string", raw);
      return;
    }
    // Env var absent: apply fallback chain, record last_error.
    const fallback =
      varDefault !== undefined
        ? varDefault
        : typeof this.defaultEmptyValue === "string"
          ? this.defaultEmptyValue
          : "";
    this.store.defineBox(name, "string", fallback);
    this.recordError(name, `env var "${envVar}" is not set`);
  }

  // ─── Async source kinds ───────────────────────────────────────────────────

  // shell: spawn command in /bin/sh, its stdout is the text the parser sees.
  declareShell(name: string, command: string, opts: ShellOptions): void {
    this.declareSource(
      name,
      shellReader(command, opts.cwd, this.abort.signal),
      clampShellCache(name, opts.cache),
      opts.parse,
    );
  }

  // file: read the file at path (whole, or its first line) as the text the
  // parser sees.
  declareFile(name: string, filePath: string, opts: FileOptions): void {
    this.declareSource(
      name,
      fileReader(filePath, opts.readMode ?? "whole", this.abort.signal),
      opts.cache,
      opts.parse,
    );
  }

  // [LAW:single-enforcer] THE user-source pipeline: read → parse → publish,
  // once at declaration and again whenever the cache policy fires. Shell and
  // file are two readers through this one function; text/regex/json are
  // three parsers through it. The node always holds a valid value from
  // declaration on (the fallback until the first run completes) — the cache
  // policy drives WHEN it is refreshed, never whether the node exists
  // [LAW:dataflow-not-control-flow].
  private declareSource(
    name: string,
    reader: SourceReader,
    cache: CachePolicy,
    parse: SourceParse,
  ): void {
    const publish = this.publisherFor(name, parse, reader.where);
    const update = () => this.runSource(name, reader, publish);
    update(); // initial run
    this.registerCachePolicy(name, cache, update);
  }

  // [LAW:one-type-per-behavior] One total projection of the parser arm onto
  // the node it publishes: the text arms publish a string box, the json arm a
  // document. Selected once, at declaration — the pipeline never asks again.
  private publisherFor(
    name: string,
    parse: SourceParse,
    where: string,
  ): Publish {
    switch (parse.kind) {
      case "text":
        return this.scalarPublisher(name, textParser, parse.default, where);
      case "regex":
        return this.scalarPublisher(
          name,
          regexParser(parse.regex),
          parse.default,
          where,
        );
      case "json":
        return this.documentPublisher(name, parse.default, where);
    }
  }

  private scalarPublisher(
    name: string,
    parser: Parser<string>,
    varDefault: string | undefined,
    where: string,
  ): Publish {
    const fallback = this.stringInitial(varDefault);
    this.store.defineBox(name, "string", fallback);
    return (read) => {
      const outcome = parsed(read, parser, where);
      this.noteOutcome(name, outcome);
      this.store.setBox(name, orElse(outcome, fallback));
    };
  }

  // A document's fallback is the declared default, or NO document: without a
  // default the node holds the failure itself (absent until the first scan,
  // failed with its reason after a bad one), which the scope proxy surfaces
  // as an error naming the variable [LAW:no-silent-failure] — a document has
  // no honest empty value the way a string has "".
  //
  // The default stands in for a run that had nothing to READ — a missing
  // file, a command that failed, blank output — never for text that was read and is not a
  // document: that is a broken writer, and reads as its failure (⚠) whatever
  // the default says (brandon-plugins-ktag.8fv).
  //
  // [LAW:no-ambient-temporal-coupling] A writer rewriting a file in place
  // (truncate, then write) is caught mid-update by any read that lands
  // between the two, and the text it sees is not a document. Text that does
  // not parse is therefore PENDING while a document is showing: the document
  // stays, and the failure is published only if no read replaces it within
  // TORN_WRITE_SETTLE_MS — the writer's own final write is an event that
  // re-reads and supersedes it. A writer that is truly broken shows ⚠ after
  // that settle; a document that was never good shows it at once.
  private documentPublisher(
    name: string,
    varDefault: JsonValue | undefined,
    where: string,
  ): Publish {
    const fallback: Outcome<JsonValue> =
      varDefault === undefined ? ABSENT : ok(varDefault);
    this.store.defineDocument(name, fallback);
    let pending: ReturnType<typeof setTimeout> | undefined;
    // Whether the document showing was READ (not the default standing in).
    let showingRead = false;
    this.cleanups.push(() => clearTimeout(pending));
    return (raw) => {
      clearTimeout(pending);
      // Blank text is nothing to read — a command that printed nothing, a
      // file only touched — exactly as a missing file is.
      const read: Outcome<string> =
        raw.kind === "ok" && raw.value.trim() === "" ? ABSENT : raw;
      const outcome = parsed(read, jsonParser, where);
      this.noteOutcome(name, outcome);
      const next =
        outcome.kind === "ok" || read.kind === "ok" || varDefault === undefined
          ? outcome
          : fallback;
      const torn = showingRead && read.kind === "ok" && outcome.kind !== "ok";
      const show = () => {
        showingRead = outcome.kind === "ok";
        this.store.setDocument(name, next);
      };
      if (torn) {
        pending = setTimeout(show, TORN_WRITE_SETTLE_MS);
      } else {
        show();
      }
    };
  }

  private runSource(
    name: string,
    reader: SourceReader,
    publish: Publish,
  ): void {
    // [LAW:no-ambient-temporal-coupling] A trigger that arrives while this
    // source is mid-read is not a duplicate to drop: it means the inputs the
    // running read is about to publish are already stale. The trailing edge
    // remembers it and re-reads once more, so the published value is the last
    // trigger's, never whichever one happened not to collide. Dropping it was
    // only ever survivable for `ttl`, which asks again on a clock; a
    // `depends_on`, `key` or `watch_file` trigger fires once and never again,
    // so a dropped one stayed stale forever (brandon-var-sources-tex).
    //
    // [LAW:no-silent-failure] A cancelled read publishes nothing; the
    // registry's own abort is the one rejection a run may end in. Any other
    // rejection is a bug and stays unhandled — loud.
    const trigger = this.reads.run(name, () =>
      reader.read().then(publish, (err: unknown) => {
        if (err !== this.abort.signal.reason) throw err;
      }),
    );
    // A queued trigger needs no tracking: the loop it joined is already the
    // tracked promise, and it does not resolve until that trigger's own pass has
    // run — which is exactly what makes `settled()` wait for the re-read too.
    if (trigger.kind === "started") this.track(name, trigger.done);
  }

  // [LAW:single-enforcer] The one writer of `inFlight`: an async source's
  // pending work enters here and leaves when it completes, so "which sources
  // are still out" has a single mechanism rather than one per source kind.
  // Several names may share one promise (every git field of a cwd rides one
  // subscription); each gets its own entry and clears independently.
  private track(name: string, work: Promise<void>): void {
    // The identity check is the same one SingleFlight makes, for the same
    // reason: `TrailingEdge` releases a key before this `finally` runs, so a
    // trigger landing in that window starts a NEW tracked loop, and an
    // unconditional delete here would remove the live entry and leave
    // `settled()` no longer waiting for work that is still out.
    const tracked: Promise<void> = work.finally(() => {
      if (this.inFlight.get(name) === tracked) this.inFlight.delete(name);
    });
    this.inFlight.set(name, tracked);
  }

  // [LAW:no-ambient-temporal-coupling] Resolves when every async source's
  // pending work — a shell/file run, a git subscription's first delivery, and
  // every run one of them triggered (a `depends_on` reaction fires inside a
  // publish) — has completed, or at the deadline. The value is the names still
  // in flight: empty when all settled. This is the state a one-shot render
  // (`cc-candybar check`) awaits so it renders what those sources yielded,
  // never a guessed delay; the registry owns the timer, so no caller races one
  // of its own.
  async settled(withinMs: number): Promise<readonly string[]> {
    const deadline = Date.now() + withinMs;
    while (this.inFlight.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        Promise.all(this.inFlight.values()).then(() => "settled" as const),
        new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => resolve("deadline"), remaining);
        }),
      ]);
      clearTimeout(timer);
      if (outcome === "deadline") break;
    }
    return [...this.inFlight.keys()];
  }

  // template: a variable whose value is derived by evaluating a go-template
  // against the current variable store.  MobX auto-tracks every store.read()
  // made during evaluation — no explicit dep declarations needed.
  // [LAW:dataflow-not-control-flow] defineComputed registers a MobX computed;
  // the invalidation graph builds itself from the template's read pattern.
  declareTemplate(
    name: string,
    template: string,
    opts: TemplateOptions = {},
  ): void {
    // Parse once at declaration time — parse() is expensive; evaluate() is cheap.
    // A ParseError propagates here so invalid templates fail at config load, not
    // at the first render.
    const parsedTpl = this.engine.parse(template);
    this.declareDerived(
      name,
      () =>
        parsedTpl
          .evaluate(buildScope(this.store))
          .map((f) => f.plain)
          .join(""),
      opts.varDefault,
    );
  }

  // time: the instant the render is drawn at, formatted with a Go
  // reference-time layout — a derivation of the registry's one clock like a
  // template reading `now`, so it changes exactly when a render's instant does.
  declareTime(name: string, opts: TimeOptions): void {
    this.declareDerived(
      name,
      () => formatGoTime(opts.format, this.now()),
      opts.varDefault,
    );
  }

  // [LAW:one-type-per-behavior] The one shape of a derived string variable — a
  // template and a time variable differ only in what they compute. Evaluated at
  // its first read, never at declaration: there is no instant to read the time
  // at until a render publishes one, and cycles are the loader's to refuse
  // (validateNoCycles) [LAW:single-enforcer].
  private declareDerived(
    name: string,
    derive: () => string,
    varDefault: string | undefined,
  ): void {
    this.store.defineComputed(name, "string", () => {
      try {
        const result = derive();
        this.lastErrors.delete(name);
        return result;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Recorded either way, so `cc-candybar debug` names the failure even
        // when an authored default makes the read succeed.
        this.recordError(name, message);
        // [LAW:no-silent-failure] A derivation that FAILED is not a value. With
        // no authored `default`, the read is the failure — the same contract a
        // non-ok document has (unwrapDocument in template-engine/scope.ts): the
        // segment reading it renders ⚠ naming this variable and the reason, and
        // `cc-candybar check` fails on it, instead of a blank that reads exactly
        // like an author who wanted a blank. Before this, a template throwing
        // (`{{ ramp … }}` outside any segment is the one that found it) read as
        // empty and check exited 0 (brandon-var-sources-1p6).
        //
        // An authored `default` is the author SAYING a failure here is
        // tolerable, which is the only thing that field has ever meant for a
        // template variable — so it keeps meaning it rather than becoming a knob
        // with no effect. [LAW:types-are-the-program] the discriminator is the
        // optionality already in the declaration; no new flag.
        //
        // `globals.default_empty_value` deliberately does NOT tolerate: it is a
        // global cosmetic floor for absent values, and letting it stand in for a
        // per-variable `default` would let one unrelated global silently switch
        // this loudness back off for every template in the config.
        // A derivation over a value that is not there yet is itself not there
        // yet, so whatever waits on it can wait on this variable too.
        if (varDefault === undefined) {
          throw readAbsentValue(e)
            ? new AbsentValueError(name, `variable "${name}": ${message}`)
            : new Error(`variable "${name}": ${message}`);
        }
        return varDefault;
      }
    });
  }

  // git: first-class git fields delivered by the shared GitDataProvider.
  // All git boxes for the same cwd ride one provider subscription; the
  // provider in turn collapses N subscribers in the same repo onto one
  // watcher + one cache entry.
  // [LAW:dataflow-not-control-flow] Box always holds a valid typed value;
  // the provider's watcher (HEAD + index under the resolved gitDir, plus
  // refs/heads/ when it exists — see src/daemon/cache/git.ts:watcherTargets)
  // drives when the snapshot is refreshed.
  declareGit(name: string, opts: GitOptions): void {
    const type = GIT_FIELD_TYPE[opts.field];
    // [LAW:single-enforcer] Coerce the user-supplied default to the field's
    // native type — same logic projectGitField already applies to the
    // defaultEmptyValue fallback. The schema constrains `default` to string,
    // so `"0"` is the only legal form for number fields; coerce it here so
    // defineBox receives a type-correct initial value.
    const initial =
      opts.varDefault !== undefined
        ? coerceToType(opts.varDefault, type)
        : zeroValue(type);
    this.store.defineBox(name, type, initial);

    let sub = this.gitSubscriptions.get(opts.cwd);
    if (!sub) {
      const fieldSubs = new Map<
        GitField,
        Array<{ name: string; varDefault: VarValue | undefined }>
      >();
      const subscription = this.gitProvider.subscribe(opts.cwd, (info) => {
        // [LAW:dataflow-not-control-flow] One runInAction per delivery; the
        // snapshot value decides each box's content, not whether code runs.
        this.store.runInAction(() => {
          for (const [field, subs] of fieldSubs) {
            for (const { name: subName, varDefault } of subs) {
              this.store.setBox(
                subName,
                projectGitField(
                  info,
                  field,
                  varDefault,
                  this.defaultEmptyValue,
                ),
              );
            }
          }
        });
      });
      sub = {
        fieldSubs,
        firstDelivery: subscription.firstDelivery,
        unsubscribe: subscription.unsubscribe,
      };
      this.gitSubscriptions.set(opts.cwd, sub);
    }

    let fieldList = sub.fieldSubs.get(opts.field);
    if (!fieldList) {
      fieldList = [];
      sub.fieldSubs.set(opts.field, fieldList);
    }
    fieldList.push({ name, varDefault: opts.varDefault });
    // [LAW:one-source-of-truth] `inFlight` is the one answer to "is any source
    // still working", so a git box's first delivery belongs in it exactly as a
    // shell run does — otherwise `settled()` is total over one KIND of async
    // source and silently partial over the other, which is what made
    // `cc-candybar check` print a branchless bar and report nothing pending.
    // The box already holds a valid typed value, so this changes no render: it
    // only makes the wait honest.
    this.track(name, sub.firstDelivery);
  }

  // state: read-through to SessionState. The computed reads two deps — the
  // canonical session-id input variable (SESSION_ID_VAR_NAME, refreshed per
  // render from input) and SessionState itself (MobX-tracked via its
  // internal atom). A click verb that mutates SessionState invalidates this
  // computed; a sessionId change (per-render) also invalidates it.
  // Persistence rides on SessionState's disk backing — no extra wiring.
  //
  // [LAW:dataflow-not-control-flow] Same body every evaluation; values
  // determine the result, never whether code runs.
  declareState(name: string, opts: StateOptions): void {
    if (!this.sessionState) {
      throw new Error(
        `declareState("${name}"): SourceRegistry was constructed without a SessionState — ` +
          `state-kind variables require a SessionState (the daemon provides one; tests must supply one)`,
      );
    }
    const sessionState = this.sessionState;
    const fallback = opts.varDefault ?? this.stringInitial(undefined);
    this.store.defineComputed(name, "string", (read) => {
      // [LAW:types-are-the-program] By convention session.id is declared as
      // a string-typed input variable. The var-system's type discipline
      // (assertType in store.ts) enforces that at declaration; we read its
      // value as a string here. A user who redeclares session.id as a
      // non-string variable receives empty state lookups — the failure
      // mode is loud-by-absence rather than silently coerced.
      const sessionId = read(SESSION_ID_VAR_NAME);
      if (typeof sessionId !== "string" || !sessionId) return fallback;
      const value = sessionState.get(sessionId, opts.key);
      return value !== null ? value : fallback;
    });
  }

  // [LAW:one-source-of-truth] The revision of the session state this render's
  // `state` variables read (SessionStateReader.revision), found the way they
  // find it: through the session id the render was handed. A registry with no
  // session state, or a render naming no session, reads none — one state that
  // never changes.
  stateRevision(): number {
    const sessionId = this.store.has(SESSION_ID_VAR_NAME)
      ? this.store.read(SESSION_ID_VAR_NAME)
      : "";
    return this.sessionState !== undefined &&
      typeof sessionId === "string" &&
      sessionId !== ""
      ? this.sessionState.revision(sessionId)
      : 0;
  }

  // ─── Render-cycle driver ──────────────────────────────────────────────────

  // Called at the start of each render request. Pushes all input-kind boxes in
  // a single runInAction so their dependents invalidate exactly once.
  // [LAW:dataflow-not-control-flow] Variability lives in the payload values,
  // not in whether the update runs — every input box is refreshed every render.
  applyInput(payload: unknown): void {
    this.store.runInAction(() => {
      for (const [name, meta] of this.inputMetas) {
        const raw = resolvePath(payload, meta.path);
        const type = this.store.getType(name);
        if (raw !== undefined) {
          try {
            this.store.setBox(name, coerceToType(raw, type));
            this.lastErrors.delete(name);
          } catch (e) {
            this.applyFallback(
              name,
              type,
              meta.varDefault,
              e instanceof Error ? e.message : String(e),
            );
          }
        } else {
          this.applyFallback(
            name,
            type,
            meta.varDefault,
            `input path "${meta.path}" not found in payload`,
          );
        }
      }
    });
  }

  // Called by the render beside applyInput: the depth this render draws at.
  drawAt(depth: ColorDepth): void {
    this.store.runInAction(() => this.drawn.set(depth));
  }

  // Called by the render beside drawAt: the instant this render is drawn at.
  renderAt(at: Instant): void {
    this.store.runInAction(() => this.instant.set(at));
  }

  // ─── Diagnostics ─────────────────────────────────────────────────────────

  // Returns the recorded error for a variable, or undefined if the last
  // resolution succeeded (or the variable has never been resolved).
  getLastError(name: string): LastError | undefined {
    const read = this.lastErrors.get(name);
    const fault = this.policyFaults.get(name);
    if (fault === undefined) return read;
    return read === undefined
      ? fault
      : {
          timestamp: read.timestamp,
          message: `${fault.message}; ${read.message}`,
        };
  }

  // Every variable whose cache policy cannot fire, with why: each render
  // reports them (`RenderWarning` kind `refresh`), since the bar draws such a
  // variable's last value with nothing of its own to say it has stopped.
  cachePolicyFaults(): ReadonlyMap<string, LastError> {
    return this.policyFaults;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  // Tear down all TTL timers, fs watchers, MobX reactions, git
  // subscriptions, and in-flight reads registered by async source kinds.
  // Call when the registry is no longer needed (e.g. on daemon shutdown or
  // config hot-reload). Returns how many computeds the store released, for
  // the caller's log line.
  dispose(): number {
    this.abort.abort();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    for (const sub of this.gitSubscriptions.values()) sub.unsubscribe();
    this.gitSubscriptions.clear();
    // A trigger queued while a read was in flight must not be honoured after
    // teardown: the abort above cancels the read that is out, and this drops the
    // re-read it would otherwise have asked for.
    this.reads.clear();
    this.watchMgr.dispose();
    this.ttlMgr.dispose();
    if (this.ownsGitProvider) this.gitProvider.close();
    // The store's computeds are the last handles outward: a keepAlive computed
    // stays subscribed to the daemon-wide SessionState atom until released, and
    // that subscription held every disposed config's store for the life of the
    // daemon (brandon-unfiled-3248.t14). [LAW:single-enforcer] released here,
    // where every other handle a config holds is.
    return this.store.dispose();
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  // [LAW:single-enforcer] One place that maps every CachePolicy kind to its
  // trigger mechanism.  Adding a new policy kind means adding one case here.
  private registerCachePolicy(
    name: string,
    policy: CachePolicy,
    update: () => void,
  ): void {
    switch (policy.kind) {
      case "never":
        // Initial run in declare* is the only execution.
        break;

      case "ttl": {
        const unsub = this.ttlMgr.subscribe(policy.durationMs, update);
        this.cleanups.push(unsub);
        break;
      }

      case "watch_file": {
        const unsub = this.watchMgr.subscribe(policy.path, update, (message) =>
          this.notePolicy(name, failed(message)),
        );
        this.cleanups.push(unsub);
        break;
      }

      case "key": {
        // Parse template once; reaction re-evaluates it whenever any
        // variable it reads changes.  If the rendered key string changes,
        // the source is recomputed.
        // [LAW:dataflow-not-control-flow] The key template is the sole
        // selector — no manual dep declarations, no conditional checks.
        const parsedKey = this.engine.parse(policy.template);
        // [LAW:no-silent-failure] A key that throws is no key: it is the
        // variable's standing fault until the key evaluates again, and the
        // source keeps what its last run yielded. Folding the throw into a
        // key value made a key that always throws a constant one — the
        // source never ran again and nothing said why. A key over a value
        // that is not there yet is `absent`, not a fault: the reaction
        // tracks that value and fires when it arrives, and the value's own
        // variable says why it is missing.
        const keyOf = (): Outcome<string> => {
          try {
            return ok(
              parsedKey
                .evaluate(buildScope(this.store))
                .map((f) => f.plain)
                .join(""),
            );
          } catch (e) {
            return readAbsentValue(e)
              ? ABSENT
              : failed(
                  `cache key: ${e instanceof Error ? e.message : String(e)}`,
                );
          }
        };
        // The key the source last ran under: the declare-time run's, until a
        // key that differs from it runs the source again. Measured against
        // that rather than the previous evaluation, so a key that throws for a
        // moment and comes back unchanged runs nothing.
        const declared = keyOf();
        this.notePolicy(name, declared);
        let ranUnder = declared.kind === "ok" ? declared.value : undefined;
        const disposer: IReactionDisposer = reaction(keyOf, (key) => {
          this.notePolicy(name, key);
          if (key.kind !== "ok" || key.value === ranUnder) return;
          ranUnder = key.value;
          update();
        });
        this.cleanups.push(disposer);
        break;
      }

      case "depends_on": {
        // [LAW:dataflow-not-control-flow] reaction re-runs update whenever
        // any named variable changes.  Variability lives in the dep values,
        // not in whether the update executes — the update always runs when
        // the joined snapshot changes.
        const disposer: IReactionDisposer = reaction(
          () => policy.varNames.map((n) => this.store.changeKey(n)).join(","),
          update,
        );
        this.cleanups.push(disposer);
        break;
      }
    }
  }

  // Failure chain: per-variable default → defaultEmptyValue coerced to type → zero.
  // [LAW:no-defensive-null-guards] Each fallback level is deliberate; the zero
  // backstop is the only "silent" path and exists because the caller has already
  // recorded the error — downstream reads get a safe typed value, not an exception.
  private applyFallback(
    name: string,
    type: VarType,
    varDefault: VarValue | undefined,
    errorMessage: string,
  ): void {
    this.recordError(name, errorMessage);
    if (varDefault !== undefined) {
      this.store.setBox(name, varDefault);
      return;
    }
    try {
      this.store.setBox(name, coerceToType(this.defaultEmptyValue, type));
    } catch {
      this.store.setBox(name, zeroValue(type));
    }
  }

  // Initial value for an input box before the first render push.
  private defaultFor(type: VarType): VarValue {
    try {
      return coerceToType(this.defaultEmptyValue, type);
    } catch {
      return zeroValue(type);
    }
  }

  // Initial string value for shell/file boxes before the first async run.
  private stringInitial(varDefault: string | undefined): string {
    if (varDefault !== undefined) return varDefault;
    if (typeof this.defaultEmptyValue === "string")
      return this.defaultEmptyValue;
    return "";
  }

  private recordError(name: string, message: string): void {
    this.lastErrors.set(name, { timestamp: Date.now(), message });
  }

  // The one fold from a policy's own outcome — whether it can fire — to the
  // variable's standing fault.
  private notePolicy(name: string, outcome: Outcome<unknown>): void {
    if (outcome.kind === "failed")
      this.policyFaults.set(name, {
        timestamp: Date.now(),
        message: outcome.reason,
      });
    else this.policyFaults.delete(name);
  }

  // [LAW:single-enforcer] The one fold from a source outcome to the
  // variable's error record: ok clears it, anything else records the reason.
  private noteOutcome(name: string, outcome: Outcome<unknown>): void {
    if (outcome.kind === "ok") this.lastErrors.delete(name);
    else
      this.recordError(
        name,
        outcome.kind === "failed" ? outcome.reason : "no value",
      );
  }
}
