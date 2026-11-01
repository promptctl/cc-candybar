// [LAW:one-source-of-truth] Source kinds are the bridge between external
// data (render payload, environment, static config) and the VariableStore.
// An input is a derived value of its path in the view's bound InputSource
// (brandon-unfiled-3248.8ro6, step 4): nothing writes one, so no draw can
// start a cache policy that reads one.
//
// Two concerns deliberately separated:
// - VariableStore: reactivity primitives (boxes, computeds, MobX scheduling)
// - SourceRegistry: source-kind semantics (path resolution, fallback chain,
//   last_error tracking)

import type { Launcher } from "../proc/launch";
import { debug } from "../utils/logger";
import { readFile as fsReadFile } from "fs/promises";
import {
  WatcherRegistry,
  watchFault,
  watchTargetsOf,
  type BoundWatch,
  type Invalidation,
  type PathsWatch,
} from "../daemon/cache/watchers.js";
import {
  NO_FILE_EVENTS,
  stallReason,
  type DeliveryNotice,
  type FileEvents,
} from "../daemon/cache/file-events.js";
import { setInterval, clearInterval } from "timers";
import {
  computed,
  observable,
  reaction,
  runInAction,
  when,
  type IReactionDisposer,
} from "mobx";
import type { ColorDepth } from "@promptctl/rich-js";
import {
  typeOf,
  toString,
  toNumber,
  toBool,
  type VarType,
  type VarValue,
} from "./types.js";
import { VariableStore, type Derivation, type StoredValue } from "./store.js";
import { createCcCandybarEngine } from "../template-engine/engine.js";
import { buildScope } from "../template-engine/scope.js";
import {
  ok,
  failed,
  orElse,
  ABSENT,
  PENDING,
  type Outcome,
  type Reading,
} from "../utils/outcome.js";
import {
  jsonParser,
  regexParser,
  textParser,
  type Parser,
  type SourceParse,
} from "./parse.js";
import { PendingValueError, readPending, type JsonValue } from "./types.js";
import type { SessionStateReader } from "../daemon/session-state.js";
import { TrailingEdge, type Trigger } from "../utils/trailing-edge.js";
import {
  RefreshLedger,
  type Refreshes,
  type RefreshTrigger,
} from "../utils/refresh-ledger.js";
import { valueOf } from "../utils/logfmt.js";

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
  // cwd. Required, because the daemon is detached — its
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
  // What the template's text is read as.
  readonly type: VarType;
  readonly varDefault?: VarValue;
  // Whether the template reads the instant: the projection fold's answer
  // (src/config/loader/projections.ts), never the registry's guess.
  readonly derivation: Derivation;
}

export interface TimeOptions {
  // Go reference-time layout string (e.g. "15:04:05", "2006-01-02").
  // Reference time: Mon Jan 2 15:04:05 MST 2006
  readonly format: string;
  readonly varDefault?: string;
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
  launcher: Launcher,
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
      const r = await launcher.launch({
        bin: "/bin/sh",
        args: ["-c", command],
        cwd,
        category: "user-shell",
        signal,
      });
      // Only the source's own abort ends a run. The launcher's is a daemon
      // closing under a live source: a failed read, like any other.
      if (!r.ok && r.reason === "aborted" && signal.aborted)
        throw signal.reason;
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
// What the read stored: its outcome, once parsed.
type Publish = (read: Outcome<string>) => Outcome<unknown>;

// What makes a user source read: its first read, and then what its cache
// policy names — a period, or a change (a watched file, its key or
// dependencies moving).
type UserTrigger = Extract<RefreshTrigger, "first" | "period" | "change">;

// [LAW:one-source-of-truth] A cache policy's refresh, in the ledger's
// vocabulary.
function refreshOf(policy: CachePolicy): readonly UserTrigger[] {
  switch (policy.kind) {
    case "never":
      return ["first"];
    case "ttl":
      return ["first", "period"];
    case "watch_file":
    case "key":
    case "depends_on":
      return ["first", "change"];
  }
}

// A policy over what a source reads runs it first when that answers, and on
// every change of the answer after.
function firstThenChange(
  update: (cause: RunCause, by: UserTrigger) => void,
): () => void {
  let ran = false;
  return () => {
    update("new-key", ran ? "change" : "first");
    ran = true;
  };
}

// ─── PathWatches ──────────────────────────────────────────────────────────────

// What a watch says to each subscriber: why it may be missing changes to its
// path right now, or `null` when it hears every place the path can change.
type WatchFault = (fault: string | null) => void;

interface WatchEntry {
  // Where the path can change, as last derived from disk, and the watcher
  // registry's watch on it.
  bound: BoundWatch;
  // Each subscriber's update, and where it hears the watch's fault.
  readonly subscribers: Map<() => void, WatchFault>;
}

// [LAW:single-enforcer] One watch per path regardless of subscriber count:
// several shell/file variables can share it. The directory watches are the
// watcher registry's, which opens, shares, counts and logs every one in the
// daemon; this follows each path's spec and fans its windows out.
//
// A path is watched wherever it can change (`watchTargetsOf`, the rule the
// config watcher shares): each directory through which its link chain passes,
// filtered to the names there, and the path itself when it is a directory. A
// directory, never a file, because a watch on a file binds its inode: it
// never sees a file created after it (an app that has not written yet) and
// goes deaf after the first atomic rename (write-then-rename, the safe way to
// rewrite a file). A directory that does not exist yet is watched through its
// nearest existing ancestor, and each one that appears moves the watch one
// level deeper.
class PathWatches {
  private readonly entries = new Map<string, WatchEntry>();
  private readonly releaseDelivery: () => void;

  constructor(
    private readonly watchers: WatcherRegistry,
    private readonly fileEvents: FileEvents,
  ) {
    this.releaseDelivery = fileEvents.subscribe((notice) =>
      this.noticed(notice),
    );
  }

  subscribe(
    filePath: string,
    callback: () => void,
    onFault: WatchFault,
  ): () => void {
    const entry = this.entries.get(filePath) ?? this.arm(filePath);
    entry.subscribers.set(callback, onFault);
    onFault(this.faultOf(filePath, entry));
    return () => this.unsubscribe(filePath, callback);
  }

  private arm(filePath: string): WatchEntry {
    const watch = derived(filePath);
    const entry: WatchEntry = {
      bound: {
        derived: watch,
        held: this.watchers.follow(null, watch, (heard) =>
          this.heard(filePath, entry, heard),
        ).watch,
      },
      subscribers: new Map(),
    };
    this.entries.set(filePath, entry);
    return entry;
  }

  // Derive where the path can change, follow it, and say the watch's fault.
  // A new key acquires its watch, keeping every directory both keys name.
  private rederive(filePath: string, entry: WatchEntry): void {
    const paths = derived(filePath);
    const { watch } = this.watchers.follow(entry.bound.held, paths, (heard) =>
      this.heard(filePath, entry, heard),
    );
    entry.bound = { derived: paths, held: watch };
    this.report(filePath, entry);
  }

  // A window re-derives and re-reads.
  private heard(
    filePath: string,
    entry: WatchEntry,
    heard: Invalidation,
  ): void {
    const wasLeaf = entry.bound.derived.reached;
    this.rederive(filePath, entry);
    // Ancestor churn on the way DOWN is not a change to the path; a move
    // up from the leaf is its removal, which the subscribers must read. A
    // failed directory may have missed a change, so its window always reads.
    if (heard.kind !== "failed" && !wasLeaf && !entry.bound.derived.reached)
      return;
    for (const cb of entry.subscribers.keys()) cb();
  }

  private report(filePath: string, entry: WatchEntry): void {
    const fault = this.faultOf(filePath, entry);
    for (const onFault of entry.subscribers.values()) onFault(fault);
  }

  // The watch's fault, derived from what it holds now and whether the OS is
  // delivering what it would hear. A stall is every watch's: it rides the
  // delivery owner's one stream.
  private faultOf(filePath: string, entry: WatchEntry): string | null {
    return watchFault(
      `watch_file ${filePath}`,
      entry.bound,
      stallReason(this.fileEvents.delivery()),
    );
  }

  // [LAW:no-silent-failure] Delivery moved or a span closed, so the watches
  // may have missed events: each watch re-derives where its path can change,
  // since a directory may have appeared unheard, which says its fault, and
  // every subscriber re-reads as if its own watch had reported. Both together,
  // so no variable drops a stall's fault without reading again, and in one
  // action, so one change of delivery is one publish.
  private noticed(notice: DeliveryNotice): void {
    switch (notice.kind) {
      case "period":
        return;
      case "moved":
      case "caught-up":
        runInAction(() => {
          for (const [filePath, entry] of this.entries) {
            this.rederive(filePath, entry);
            for (const cb of entry.subscribers.keys()) cb();
          }
        });
        return;
    }
  }

  private unsubscribe(filePath: string, callback: () => void): void {
    const entry = this.entries.get(filePath);
    if (!entry) return;
    entry.subscribers.delete(callback);
    if (entry.subscribers.size === 0) {
      entry.bound.held.handle.release();
      this.entries.delete(filePath);
    }
  }

  dispose(): void {
    this.releaseDelivery();
    for (const entry of this.entries.values())
      entry.bound.held.handle.release();
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

// Where the path can change: every hop of its link chain by name, and the
// path itself when it is a directory.
const derived = (filePath: string): PathsWatch =>
  watchTargetsOf({ named: [filePath], whole: [filePath] });

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

// What a registry's sources have published: each one's stored value, and the
// standing fault of each policy that cannot fire.
export interface Published {
  readonly values: readonly StoredValue[];
  readonly faults: readonly LastError[];
}

// [LAW:types-are-the-program] What a view's inputs are derived from: the value
// at each payload path as it stands — PENDING while its source has not
// answered — and the depth the view's renders draw at, which every contrast
// floor reads. A read is tracked, so an input moves in the turn its value
// does, and nothing else moves it.
export interface InputSource {
  read(path: string): unknown;
  drawnAt(): ColorDepth;
}

// A registry no view source is bound to: a directory's, which reads no
// payload, or a view's before its source is bound — every input not answered,
// and its depth neither, so a key measuring a floor waits for the view's
// rather than running once at a depth no draw is at.
const UNBOUND: InputSource = {
  read: () => PENDING,
  drawnAt: () => {
    throw new PendingValueError(
      "colorCompatibility.effective",
      "the drawn depth has no value yet: no view source is bound",
    );
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Recursively resolves a dotted path through a plain object.
// Returns undefined if any segment is absent or the traversed value is not an
// object. [LAW:types-are-the-program] A PENDING node is a source that has not
// answered yet, so every path through it is pending too: one `git: PENDING`
// is every `git.*` input not answered, never each one's default.
export function resolvePath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === PENDING) return PENDING;
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// [LAW:parse-dont-validate] What a view's payload holds at a source's name,
// as the document's reading: the source's own outcome, PENDING while it has
// not answered, and a failure for anything else.
function sourceReading(name: string, raw: unknown): Reading<JsonValue> {
  if (raw === PENDING) return PENDING;
  if (raw === undefined) {
    return failed(
      `variable "${name}": the view's payload has no "${name}": its declaration did not take the source the preset reads`,
    );
  }
  const kind =
    typeof raw === "object" && raw !== null
      ? (raw as { kind?: unknown }).kind
      : undefined;
  switch (kind) {
    case "ok":
    case "absent":
    case "failed":
      return raw as Reading<JsonValue>;
    default:
      return failed(
        `variable "${name}": the view's payload holds no source reading at "${name}"`,
      );
  }
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

// Why a source runs: for a key it has no answer under yet — its first run, or
// a key or dependency that moved — or to re-read the key it has answered, on
// a period's tick or a watched file's change. A re-read keeps its answer
// standing; a new key has none, so a wait is for it alone.
type RunCause = "new-key" | "re-read";

export class SourceRegistry {
  private readonly lastErrors = new Map<string, LastError>();
  // A cache policy that cannot fire is a STANDING fault, not a read's
  // outcome: a read that succeeds afterwards says nothing about whether the
  // source will ever run again, so no read outcome clears it. A watch that
  // cannot hear every place its path changes lives until it can again (its
  // own re-derive says so); a key template that throws lives
  // until the key evaluates again. One map, since a variable has one policy.
  // Observable, since the bar draws each fault as a refresh warning.
  private readonly policyFaults = observable.map<string, LastError>(undefined, {
    deep: false,
  });

  // Triggers for shell/file cache policies and the time source's tick:
  private readonly watchMgr: PathWatches;
  private readonly ttlMgr = new TtlBucketManager();
  // Collects all cleanup callbacks (TTL unsubscribes, watch unsubscribes,
  // MobX reaction disposers) so dispose() tears everything down in one call.
  private readonly cleanups: Array<() => void> = [];
  // Each async source's in-flight loop, by name: one per source at a time.
  private readonly runs = new Map<string, Promise<void>>();
  // [LAW:no-ambient-temporal-coupling] The sources whose loop out answers a
  // key they have no answer under yet (`RunCause`). Observable, so
  // `inFlight()` is a reaction over it — the explicit "the runs a wait is for
  // have ended" state a caller (a statusline request, `cc-candybar check`)
  // awaits instead of guessing a delay, and one its deadline can stop
  // listening to. Set by the trigger, since a source's node holds its
  // fallback before its first answer (`stringInitial`), so the store cannot
  // say it.
  private readonly newKeys = observable.set<string>();
  // [LAW:single-enforcer] Serializes each source's reads and remembers a trigger
  // that arrived mid-read, so a re-trigger re-reads once rather than starting a
  // parallel read or being dropped. Shared with the git cache's refresh path,
  // which had the same problem first — see src/utils/trailing-edge.ts.
  private readonly reads = new TrailingEdge();
  // Each source's latest trigger, which the pass that answers it records.
  private readonly askedBy = new Map<string, UserTrigger>();
  // [LAW:single-enforcer] The registry owns every async handle its sources
  // hold — timers, watchers, reactions, and the child processes and file
  // reads in flight. This is their cancellation: dispose() aborts it, so a
  // run cannot outlive the registry that started it (RenderCache's
  // dispose-before-swap contract reaches the children too).
  private readonly abort = new AbortController();
  // [LAW:one-source-of-truth] What this registry's inputs are derived from
  // (`bindInputs`), and so the depth the terminal draws this view's renders at
  // — the one depth every contrast floor reads, in this registry's variable
  // templates and in the render engine alike. Derived from the view's own
  // settings, so a template variable whose `readableOn` read it recomputes in
  // the turn the setting moves (edit mode staging a depth included), never at
  // a draw.
  private readonly inputs = observable.box<InputSource>(UNBOUND, {
    deep: false,
  });
  readonly drawnAt = (): ColorDepth => this.inputs.get().drawnAt();
  // Shared engine instance — parse() is expensive; the engine is reused for
  // all key: template compilations.
  // [LAW:one-source-of-truth] One engine per registry, not one per variable.
  private readonly engine = createCcCandybarEngine({ drawnAt: this.drawnAt });

  // The names of this registry's own async sources (shell, file), whose
  // stored values `published` reads.
  private readonly sourceNames = observable.array<string>([], { deep: false });
  // [LAW:one-source-of-truth] What this registry's sources have published, as
  // one value that changes exactly when one of their stored values or
  // standing faults does: the store writes a value only when its own compare
  // finds it changed, and a fault is written only when its reason does, so a
  // re-read that found what was stored moves nothing. A session's view reacts
  // to it, and so its feed wakes on a publish that changed what the bar can
  // show (openView).
  private readonly publishedNow = computed(
    (): Published => ({
      values: this.sourceNames.map((name) => this.store.stored(name)),
      faults: [...this.policyFaults.values()],
    }),
  );
  published(): Published {
    return this.publishedNow.get();
  }

  // [LAW:locality-or-seam] sessionState is injected (not constructed here)
  // so tests can substitute a fake and the daemon shares its singleton.
  // Absent in non-daemon contexts; declareState() rejects loudly in that case
  // rather than silently returning empty strings.
  private readonly sessionState: SessionStateReader | undefined;

  // defaultEmptyValue is the global fallback of last resort — the config-level
  // `default_empty_value` from the proposal. Defaults to empty string.
  //
  // sessionState lets the daemon inject its singleton so state-kind variables
  // share one MobX atom and one disk-persistence layer with the click verbs.
  // Omitted in tests that don't exercise state vars.
  constructor(
    // Who a shell source's program belongs to.
    private readonly launcher: Launcher,
    private readonly store: VariableStore,
    private readonly defaultEmptyValue: VarValue = "",
    sessionState?: SessionStateReader,
    // The directory home a session's view reads through to (`view()`).
    private readonly parent: SourceRegistry | null = null,
    // [LAW:single-enforcer] The daemon's one ledger, which every source's
    // refreshes are recorded in; a registry outside the daemon keeps its own.
    private readonly ledger: RefreshLedger = new RefreshLedger(),
    // [LAW:one-source-of-truth] The daemon's one word on whether the OS is
    // delivering file events, which its `watch_file` sources' watches ride.
    // Only the daemon measures delivery.
    private readonly fileEvents: FileEvents = NO_FILE_EVENTS,
    // [LAW:single-enforcer] The daemon's one watcher registry, which holds
    // every directory watch its `watch_file` sources need; a registry outside
    // the daemon keeps its own.
    private readonly watchers: WatcherRegistry = new WatcherRegistry(),
  ) {
    this.sessionState = sessionState;
    this.watchMgr = new PathWatches(watchers, fileEvents);
  }

  // [LAW:one-source-of-truth] A session's view of this directory home
  // (brandon-unfiled-3248.8ro6, step 2): a registry of its own over a store of
  // its own, which reads through to this one. The session's values are
  // declared there, so its inputs, its state and its derivations are its own,
  // and what its sources fail with is recorded there; a directory value it
  // reads is this home's one node, and its failure this home's one record. It
  // shares the daemon's session state, and is disposed on its
  // own: a session leaving the directory disposes nothing of it.
  view(): SourceRegistry {
    return new SourceRegistry(
      this.launcher,
      new VariableStore(this.store),
      this.defaultEmptyValue,
      this.sessionState,
      this,
      this.ledger,
      this.fileEvents,
      this.watchers,
    );
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

  // A plugin's source: a document derived from the reading its view's payload
  // carries at the source's own name — ok, absent or failed as the storage
  // owner read the session's file, or pending while it has not answered.
  // [LAW:no-silent-failure] A payload with nothing there is a declaration
  // that did not take the source the preset reads: a bug, read as a failure
  // naming the variable, never as absent.
  declareSourceDocument(name: string): void {
    this.store.defineDerivedDocument(name, () =>
      sourceReading(name, this.inputs.get().read(name)),
    );
  }

  // [LAW:single-enforcer] A handle the registry's owner holds for as long as
  // the registry lives — a render state's hold on a plugin's storage folder —
  // released by the registry's one teardown (`dispose`), with everything else
  // it holds.
  own(release: () => void): void {
    this.cleanups.push(release);
  }

  // input: a derived value of its path in the bound InputSource, cast to its
  // type. [LAW:types-are-the-program] Before its source answers it holds no
  // value: it is not answered yet, never its default, which answers a payload
  // that lacks the path (brandon-unfiled-3248.8ro6). A path the draw's own
  // instant answers (DRAW_PROJECTIONS) is a projection, read by each draw.
  declareInput(
    name: string,
    path: string,
    type: VarType,
    varDefault: VarValue | undefined,
    derivation: Derivation,
  ): void {
    this.store.defineDerived(name, type, derivation, () =>
      this.inputAt(name, path, type, varDefault),
    );
  }

  // [LAW:single-enforcer] The one reading of an input: its path's value cast
  // to its type, else the fallback chain with the failure recorded.
  private inputAt(
    name: string,
    path: string,
    type: VarType,
    varDefault: VarValue | undefined,
  ): VarValue {
    const raw = this.inputs.get().read(path);
    if (raw === PENDING) {
      // Not answered yet is no failure: an earlier read's error no longer
      // stands for it.
      this.lastErrors.delete(name);
      throw new PendingValueError(
        name,
        `variable "${name}" has no value yet: its source has not answered`,
      );
    }
    if (raw === undefined) {
      return this.fallbackOf(
        name,
        type,
        varDefault,
        `input path "${path}" not found in payload`,
      );
    }
    try {
      const value = coerceToType(raw, type);
      this.lastErrors.delete(name);
      return value;
    } catch (e) {
      return this.fallbackOf(
        name,
        type,
        varDefault,
        e instanceof Error ? e.message : String(e),
      );
    }
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
      shellReader(this.launcher, command, opts.cwd, this.abort.signal),
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
  // whenever the cache policy fires, its first read included. Shell and file
  // are two readers through this one function; text/regex/json are three
  // parsers through it. The node holds its fallback until the first run
  // completes — the cache policy drives WHEN it is read, never whether the
  // node exists [LAW:dataflow-not-control-flow].
  private declareSource(
    name: string,
    reader: SourceReader,
    cache: CachePolicy,
    parse: SourceParse,
  ): void {
    const publish = this.publisherFor(name, parse, reader.where);
    runInAction(() => this.sourceNames.push(name));
    // [LAW:types-are-the-program] Its scope is derived, never authored: a
    // view's source reads a session value, a directory home's reads none.
    const refreshes = this.ledger.declare({
      name: `var.${name}`,
      scope: this.parent === null ? "directory" : "view",
      refresh: refreshOf(cache),
    });
    this.registerCachePolicy(name, cache, (cause, by) =>
      this.runSource(name, reader, publish, cause, by, refreshes),
    );
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
      return outcome;
    };
  }

  // A document's fallback is the declared default, or NO document: without a
  // default the node is pending until its first scan, then holds what the scan
  // found — absent when it had nothing to read, failed with its reason after a
  // bad one — which the scope proxy surfaces naming the variable
  // [LAW:no-silent-failure]: a document has no honest empty value the way a
  // string has "".
  //
  // The default stands in for a run that had nothing to READ — a missing
  // file, a command that failed, blank output — never for text that was read and is not a
  // document: that is a broken writer, and reads as its failure (⚠) whatever
  // the default says (brandon-plugins-ktag.8fv).
  //
  // [LAW:no-ambient-temporal-coupling] A writer rewriting a file in place
  // (truncate, then write) is caught mid-update by any read that lands
  // between the two, and the text it sees is not a document. Text that does
  // not parse is therefore held back while a document is showing: the document
  // stays, and the failure is published only if no read replaces it within
  // TORN_WRITE_SETTLE_MS — the writer's own final write is an event that
  // re-reads and supersedes it. A writer that is truly broken shows ⚠ after
  // that settle; a document that was never good shows it at once.
  private documentPublisher(
    name: string,
    varDefault: JsonValue | undefined,
    where: string,
  ): Publish {
    // What the node holds before its first scan, and — with a default — what
    // stands in for a run that had nothing to read.
    const fallback: Reading<JsonValue> =
      varDefault === undefined ? PENDING : ok(varDefault);
    this.store.defineDocument(name, fallback);
    let settling: ReturnType<typeof setTimeout> | undefined;
    // Whether the document showing was READ (not the default standing in).
    let showingRead = false;
    this.cleanups.push(() => clearTimeout(settling));
    return (raw) => {
      clearTimeout(settling);
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
        settling = setTimeout(show, TORN_WRITE_SETTLE_MS);
      } else {
        show();
      }
      // A torn read is still the failure its read met, though the document
      // stays showing until the settle.
      return outcome;
    };
  }

  private runSource(
    name: string,
    reader: SourceReader,
    publish: Publish,
    cause: RunCause,
    by: UserTrigger,
    refreshes: Refreshes<UserTrigger>,
  ): void {
    // The latest trigger is the one a coalesced pass answers.
    this.askedBy.set(name, by);
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
    const trigger = this.reads.run(name, () => {
      const asked = this.askedBy.get(name) ?? by;
      const startedAt = Date.now();
      return reader.read().then(
        (read) =>
          refreshes.recorded(
            `where=${valueOf(reader.where)}`,
            asked,
            publish(read),
            Date.now() - startedAt,
          ),
        (err: unknown) => {
          if (err !== this.abort.signal.reason) throw err;
        },
      );
    });
    this.track(name, trigger, cause);
  }

  // [LAW:single-enforcer] The one writer of `runs` and `newKeys`: an async
  // source's pending work enters here and leaves when it completes, so "which
  // sources are still out" has a single mechanism rather than one per source
  // kind. A queued trigger joins the loop out, which runs one more pass for it
  // before it ends: that loop answers a new key when either trigger brought
  // one.
  private track(name: string, trigger: Trigger, cause: RunCause): void {
    runInAction(() => {
      if (trigger.kind === "started") {
        this.runs.set(name, trigger.done);
        this.newKeys.delete(name);
      }
      if (cause === "new-key") this.newKeys.add(name);
    });
    if (trigger.kind === "queued") return;
    const done = trigger.done;
    // The identity check is the same one SingleFlight makes, for the same
    // reason: `TrailingEdge` releases a key before this `finally` runs, so a
    // trigger landing in that window starts a NEW tracked loop, and an
    // unconditional delete here would remove the live entry and leave
    // `inFlight()` no longer waiting for work that is still out.
    // [LAW:no-silent-failure] A run's rejection is a bug and stays unhandled
    // here: a waiter watches the run leave `newKeys`, never its outcome, so
    // no wait swallows it.
    void done.finally(() =>
      runInAction(() => {
        if (this.runs.get(name) !== done) return;
        this.runs.delete(name);
        this.newKeys.delete(name);
      }),
    );
  }

  // [LAW:no-ambient-temporal-coupling] Resolves when none of the runs a wait
  // is for is out (`awaited`), or when `signal` aborts — and then holds
  // nothing, so a run that never ends keeps no waiter behind it. A run one of
  // them triggers (a `depends_on` reaction fires inside a publish) is marked
  // before the run that triggered it ends, so it is waited out too. Resolves
  // to the names still awaited: empty when all settled, the stragglers when
  // the signal ended the wait. A signal already aborted ends it at once, so a
  // caller holding one deadline over many waits pays it once.
  async inFlight(signal: AbortSignal): Promise<readonly string[]> {
    try {
      await when(() => this.awaited().length === 0, { signal });
    } catch (e) {
      // The signal's abort is the one rejection the wait expects.
      if (!signal.aborted) throw e;
    }
    return this.awaited();
  }

  // The sources a wait on this registry is for: the runs out here and in the
  // home it reads through to that answer a new key (rule 2's first value, or
  // a key its facts moved). A re-read keeps the answer it has standing, so no
  // wait is for it, whoever's period or watch started it.
  private awaited(): string[] {
    return [...this.newKeys, ...(this.parent?.awaited() ?? [])];
  }

  // The names still awaited once every run has ended or `withinMs` has
  // passed: empty when all settled. The state a one-shot render awaits so it
  // renders what those sources yielded, never a guessed delay.
  settled(withinMs: number): Promise<readonly string[]> {
    return this.inFlight(AbortSignal.timeout(withinMs));
  }

  // template: a variable whose value is derived by evaluating a go-template
  // against the current variable store.  MobX auto-tracks every store.read()
  // made during evaluation — no explicit dep declarations needed.
  // [LAW:dataflow-not-control-flow] A derived template is a MobX computed, its
  // invalidation graph built from the template's read pattern; a projection
  // (one that reads the instant: src/config/loader/projections.ts) is derived
  // again by every read, at the draw in progress.
  declareTemplate(name: string, template: string, opts: TemplateOptions): void {
    // Parse once at declaration time — parse() is expensive; evaluate() is cheap.
    // A ParseError propagates here so invalid templates fail at config load, not
    // at the first render.
    const parsedTpl = this.engine.parse(template);
    this.declareDerived(
      name,
      opts.type,
      opts.derivation,
      () =>
        parsedTpl
          .evaluate(buildScope(this.store))
          .map((f) => f.plain)
          .join(""),
      opts.varDefault,
    );
  }

  // time: the instant of the draw in progress in a Go reference-time layout —
  // a template over `now` (`{{ date <layout> now }}`), and so a projection.
  // [LAW:one-type-per-behavior] The engine's own `date` formats it: one Go
  // layout implementation, the one a template calling `date` gets.
  declareTime(name: string, opts: TimeOptions): void {
    const parsedTpl = this.engine.parse("{{ date .layout now }}");
    const scope = { layout: opts.format };
    this.declareDerived(
      name,
      "string",
      "projection",
      () =>
        parsedTpl
          .evaluate(scope)
          .map((f) => f.plain)
          .join(""),
      opts.varDefault,
    );
  }

  // [LAW:one-type-per-behavior] The one shape of a derived string variable — a
  // template and a time variable differ only in what they compute, and a
  // computed and a projection only in whether the store keeps the answer.
  // Evaluated at its first read, never at declaration: a projection has no
  // instant to read until a draw binds one, and cycles are the loader's to
  // refuse (validateNoCycles) [LAW:single-enforcer].
  private declareDerived(
    name: string,
    type: VarType,
    derivation: Derivation,
    derive: () => string,
    // Of the variable's type: the loader's `default` spec pairs the two.
    fallback: VarValue | undefined,
  ): void {
    this.store.defineDerived(name, type, derivation, () => {
      try {
        // [LAW:single-enforcer] The text is cast by the rule an input's
        // payload value is, so a template that renders no number fails as a
        // failed derivation, never as a zero.
        const result = coerceToType(derive(), type);
        this.lastErrors.delete(name);
        return result;
      } catch (e) {
        // [LAW:single-enforcer] A derivation over a value not answered yet is
        // not answered yet either — not a failure, so nothing is recorded and
        // no default answers it: a default answers a failure alone. The read
        // it rode in on is passed on whole, naming the source it waits on.
        // Its standing failure is over, as an answer ends it.
        const pending = readPending(e);
        if (pending !== undefined) {
          this.lastErrors.delete(name);
          throw pending;
        }
        const message = e instanceof Error ? e.message : String(e);
        // Recorded either way, so `cc-candybar vars` names the failure even
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
        if (fallback === undefined) {
          throw new Error(`variable "${name}": ${message}`);
        }
        return fallback;
      }
    });
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

  // ─── The view's source ────────────────────────────────────────────────────

  // [LAW:single-enforcer] What this registry's inputs, and the depth, are
  // derived from: bound once by the view that owns the registry, whose source
  // reads its payload as it stands. A directory binds none: it reads no
  // payload and no depth — a source whose key reads one is a view's
  // (src/dsl/variable-scope.ts).
  bindInputs(source: InputSource): void {
    runInAction(() => this.inputs.set(source));
  }

  // ─── Diagnostics ─────────────────────────────────────────────────────────

  // Returns the recorded error for a variable, or undefined if the last
  // resolution succeeded (or the variable has never been resolved).
  getLastError(name: string): LastError | undefined {
    // A variable's record is its home's: a view asks its directory for a
    // directory value's.
    if (!this.declaredHere(name)) return this.parent?.getLastError(name);
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
    return new Map([
      ...(this.parent?.cachePolicyFaults() ?? []),
      ...this.policyFaults,
    ]);
  }

  // Whether `name` lives in this registry's own store, not its directory's.
  private declaredHere(name: string): boolean {
    return this.store.has(name) && !(this.parent?.store.has(name) ?? false);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  // Tear down all TTL timers, fs watchers, MobX reactions, and in-flight
  // reads registered by async source kinds.
  // Call when the registry is no longer needed (e.g. on daemon shutdown or
  // config hot-reload). Returns how many computeds the store released, for
  // the caller's log line.
  dispose(): number {
    this.abort.abort();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    // A trigger queued while a read was in flight must not be honoured after
    // teardown: the abort above cancels the read that is out, and this drops the
    // re-read it would otherwise have asked for.
    this.reads.clear();
    this.watchMgr.dispose();
    this.ttlMgr.dispose();
    // The store's computeds are the last handles outward: a keepAlive computed
    // stays subscribed to the daemon-wide SessionState atom until released, and
    // that subscription held every disposed config's store for the life of the
    // daemon (brandon-unfiled-3248.t14). [LAW:single-enforcer] released here,
    // where every other handle a config holds is.
    return this.store.dispose();
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  // [LAW:single-enforcer] One place that maps every CachePolicy kind to its
  // trigger mechanism, the source's first read included: a clock, a watch or
  // nothing reads it at declaration, and a policy over what the source reads
  // reads it when that first answers.  Adding a new policy kind means adding
  // one case here.
  private registerCachePolicy(
    name: string,
    policy: CachePolicy,
    update: (cause: RunCause, by: UserTrigger) => void,
  ): void {
    switch (policy.kind) {
      case "never":
        update("new-key", "first");
        break;

      case "ttl": {
        update("new-key", "first");
        const unsub = this.ttlMgr.subscribe(policy.durationMs, () =>
          update("re-read", "period"),
        );
        this.cleanups.push(unsub);
        break;
      }

      case "watch_file": {
        update("new-key", "first");
        const unsub = this.watchMgr.subscribe(
          policy.path,
          () => update("re-read", "change"),
          (fault) =>
            this.notePolicy(
              name,
              fault === null ? ok(undefined) : failed(fault),
            ),
        );
        this.cleanups.push(unsub);
        break;
      }

      case "key": {
        // Parse template once; the reaction re-evaluates it whenever any
        // variable it reads changes.
        // [LAW:dataflow-not-control-flow] The key template is the sole
        // selector — no manual dep declarations, no conditional checks.
        const parsedKey = this.engine.parse(policy.template);
        // [LAW:no-silent-failure] A key that throws is no key: it is the
        // variable's standing fault until the key evaluates again, and the
        // source keeps what its last run yielded. Folding the throw into a
        // key value made a key that always throws a constant one — the
        // source never ran again and nothing said why.
        this.onReads(
          name,
          () => {
            try {
              return ok(
                parsedKey
                  .evaluate(buildScope(this.store))
                  .map((f) => f.plain)
                  .join(""),
              );
            } catch (e) {
              return readPending(e) !== undefined
                ? PENDING
                : failed(
                    `cache key: ${e instanceof Error ? e.message : String(e)}`,
                  );
            }
          },
          firstThenChange(update),
        );
        break;
      }

      case "depends_on": {
        // [LAW:dataflow-not-control-flow] The source re-reads whenever any
        // named variable changes. Variability lives in the dep values, not in
        // whether the update executes.
        this.onReads(
          name,
          (): Reading<string> => {
            const keys = policy.varNames.map((n) => this.store.changeKey(n));
            return keys.every((key) => key.kind === "ok")
              ? ok(keys.map((key) => key.value).join(","))
              : PENDING;
          },
          firstThenChange(update),
        );
        break;
      }
    }
  }

  // [LAW:one-type-per-behavior] Both policies over what a source reads — its
  // key, the variables it depends on — read it when what they read answers,
  // and again whenever that answer differs from the one it last read under.
  // Over a value not answered yet (a view's inputs before its first payload)
  // it waits rather than reading, so its first value is one read, not a read
  // under no value and another when the value arrives (brandon-unfiled-3248.
  // 8ro6). Measured against the last read's answer rather than the previous
  // evaluation, so one that throws for a moment and comes back unchanged reads
  // nothing.
  private onReads(
    name: string,
    reads: () => Reading<string>,
    update: () => void,
  ): void {
    let readUnder: string | undefined;
    const disposer: IReactionDisposer = reaction(
      reads,
      (answer) => {
        this.notePolicy(name, answer);
        if (answer.kind !== "ok" || answer.value === readUnder) return;
        readUnder = answer.value;
        update();
      },
      { fireImmediately: true },
    );
    this.cleanups.push(disposer);
  }

  // Failure chain: per-variable default → defaultEmptyValue coerced to type → zero.
  // [LAW:no-defensive-null-guards] Each fallback level is deliberate; the zero
  // backstop is the only "silent" path and exists because the caller has already
  // recorded the error — downstream reads get a safe typed value, not an exception.
  private fallbackOf(
    name: string,
    type: VarType,
    varDefault: VarValue | undefined,
    errorMessage: string,
  ): VarValue {
    this.recordError(name, errorMessage);
    if (varDefault !== undefined) return varDefault;
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
  // A fault standing for the same reason keeps its record, so it moves
  // nothing that draws it.
  private notePolicy(name: string, outcome: Reading<unknown>): void {
    runInAction(() => {
      if (outcome.kind !== "failed") this.policyFaults.delete(name);
      else if (this.policyFaults.get(name)?.message !== outcome.reason)
        this.policyFaults.set(name, {
          timestamp: Date.now(),
          message: outcome.reason,
        });
    });
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
