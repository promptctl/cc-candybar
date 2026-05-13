// [LAW:one-source-of-truth] Source kinds are the bridge between external
// data (render payload, environment, static config) and the VariableStore.
// All payload ingestion goes through applyInput — there is no other path
// that writes input-kind boxes during a render.
//
// Two concerns deliberately separated:
// - VariableStore: reactivity primitives (boxes, computeds, MobX scheduling)
// - SourceRegistry: source-kind semantics (path resolution, fallback chain,
//   last_error tracking)

import { spawn } from "child_process";
import { readFile as fsReadFile } from "fs/promises";
import { watch as fsWatch, type FSWatcher } from "fs";
import { join as pathJoin } from "path";
import { setInterval, clearInterval } from "timers";
import { reaction, type IReactionDisposer } from "mobx";
import type { RichText } from "rich-js";
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

export interface ShellOptions {
  readonly regex?: string;
  readonly cache: CachePolicy;
  readonly varDefault?: string;
}

export interface FileOptions {
  // Ignored when regex is set (regex implies whole-file scan).
  readonly readMode?: "whole" | "first-line";
  readonly regex?: string;
  readonly cache: CachePolicy;
  readonly varDefault?: string;
}

export interface TemplateOptions {
  readonly varDefault?: string;
}

export interface TimeOptions {
  // Go reference-time layout string (e.g. "15:04:05", "2006-01-02").
  // Reference time: Mon Jan 2 15:04:05 MST 2006
  readonly format: string;
  // Refresh interval.  Defaults to 1 000 ms.
  readonly ttlMs?: number;
  readonly varDefault?: string;
}

// [LAW:one-type-per-behavior] Six git fields — each has a fixed inferred type.
// branch/sha are strings; dirty is boolean; ahead/behind/stash are numbers.
export type GitField = "branch" | "sha" | "dirty" | "ahead" | "behind" | "stash";

export interface GitOptions {
  readonly field: GitField;
  // Working directory whose git repo to query.  Resolved at declaration time.
  readonly cwd: string;
  readonly varDefault?: VarValue;
}

// ─── Private infrastructure ───────────────────────────────────────────────────

// Execute command in /bin/sh; resolve with stdout (raw) and exit code.
// [LAW:no-defensive-null-guards] Errors surface as exitCode=1 + empty stdout
// rather than throwing — the caller owns the fallback chain.
async function execShell(
  command: string,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (buf: Buffer) => {
      out += buf.toString("utf8");
    });
    child.on("close", (code) => resolve({ stdout: out, exitCode: code ?? 1 }));
    child.on("error", () => resolve({ stdout: "", exitCode: 1 }));
  });
}

interface FileResult {
  content?: string;
  error?: string;
}

// Read a file and extract the relevant text fragment.
// Returns {error} on I/O failure or regex no-match; {content} on success.
async function readFileContent(
  filePath: string,
  readMode: "whole" | "first-line" | undefined,
  regex: string | undefined,
): Promise<FileResult> {
  let raw: string;
  try {
    raw = await fsReadFile(filePath, "utf8");
  } catch {
    return { error: `file unreadable: ${filePath}` };
  }

  if (regex !== undefined) {
    const m = new RegExp(regex).exec(raw);
    if (!m?.[1]) return { error: `regex no-match in "${filePath}"` };
    return { content: m[1].replace(/\n/g, " ") };
  }

  if (readMode === "first-line") {
    return { content: (raw.split("\n")[0] ?? "").trim() };
  }

  // whole (default): newlines → spaces, trailing whitespace stripped
  return { content: raw.replace(/\n/g, " ").trim() };
}

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

// Typed snapshot of all six git fields — always fully populated.
interface GitSnapshot {
  readonly branch: string;
  readonly sha: string;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly stash: number;
}

// Invoke git with the given args in cwd.  Mirrors execShell but targets git
// directly (no /bin/sh) and sets GIT_OPTIONAL_LOCKS to avoid lock contention.
// [LAW:no-defensive-null-guards] Errors surface as exitCode ≠ 0; the caller
// owns the fallback chain.
async function execGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    let out = "";
    child.stdout.on("data", (buf: Buffer) => {
      out += buf.toString("utf8");
    });
    child.on("close", (code) => resolve({ stdout: out, exitCode: code ?? 1 }));
    child.on("error", () => resolve({ stdout: "", exitCode: 1 }));
  });
}

// Fetch all six git fields for cwd in one batched set of parallel git calls.
// Returns null when cwd is not inside a git repository.
async function fetchGitSnapshot(cwd: string): Promise<GitSnapshot | null> {
  const [statusR, shaR, aheadR, behindR, stashR] = await Promise.all([
    execGit(["status", "--porcelain=v1", "-b"], cwd),
    execGit(["rev-parse", "--short=7", "HEAD"], cwd),
    execGit(["rev-list", "--count", "@{u}..HEAD"], cwd),
    execGit(["rev-list", "--count", "HEAD..@{u}"], cwd),
    execGit(["stash", "list"], cwd),
  ]);

  // Non-zero on `git status` means not a git repo or a fatal git error.
  if (statusR.exitCode !== 0) return null;

  const lines = statusR.stdout.split("\n");
  const branchLine = lines.find((l) => l.startsWith("## ")) ?? "";
  const branchRaw = branchLine.slice(3).split("...")[0] ?? "";
  // Detached HEAD: git emits "## HEAD (no branch)" — normalise to empty string.
  const branch =
    branchRaw.startsWith("HEAD (no branch)") ? "" : branchRaw.trim();

  // Any non-header, non-empty line = working tree has changes.
  const dirty = lines.some(
    (l) => l.length > 0 && !l.startsWith("## ") && !l.startsWith("# "),
  );

  const sha = shaR.exitCode === 0 ? shaR.stdout.trim() : "";
  const ahead =
    aheadR.exitCode === 0 ? (parseInt(aheadR.stdout.trim()) || 0) : 0;
  const behind =
    behindR.exitCode === 0 ? (parseInt(behindR.stdout.trim()) || 0) : 0;
  const stashText = stashR.exitCode === 0 ? stashR.stdout.trim() : "";
  const stash = stashText ? stashText.split("\n").length : 0;

  return { branch, sha, dirty, ahead, behind, stash };
}

// [LAW:single-enforcer] One GitPoller per (SourceRegistry, cwd).  All git
// boxes for the same directory share one atomic fetch — no duplicate git
// invocations.  Watches .git/HEAD (branch/sha signal) and .git/index
// (dirty/ahead/behind/stash signal); any change triggers a full re-fetch so
// all fields stay mutually consistent.
class GitPoller {
  private readonly subscribers = new Map<
    GitField,
    Array<{ name: string; varDefault: VarValue | undefined }>
  >();
  private inFlight = false;

  constructor(
    private readonly cwd: string,
    private readonly store: VariableStore,
    private readonly defaultEmptyValue: VarValue,
    watchMgr: WatchManager,
    cleanups: Array<() => void>,
  ) {
    const refresh = (): void => void this.fetch();
    cleanups.push(watchMgr.subscribe(pathJoin(cwd, ".git", "HEAD"), refresh));
    cleanups.push(watchMgr.subscribe(pathJoin(cwd, ".git", "index"), refresh));
    refresh(); // initial fetch
  }

  addSubscriber(
    field: GitField,
    name: string,
    varDefault: VarValue | undefined,
  ): void {
    let list = this.subscribers.get(field);
    if (!list) {
      list = [];
      this.subscribers.set(field, list);
    }
    list.push({ name, varDefault });
  }

  private async fetch(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const snapshot = await fetchGitSnapshot(this.cwd);
      // [LAW:dataflow-not-control-flow] All boxes update in one action —
      // the snapshot value decides each box's content, not whether code runs.
      this.store.runInAction(() => {
        for (const [field, subs] of this.subscribers) {
          for (const { name, varDefault } of subs) {
            this.store.setBox(name, this.resolveValue(snapshot, field, varDefault));
          }
        }
      });
    } finally {
      this.inFlight = false;
    }
  }

  // Fallback chain mirrors applyFallback: snapshot → varDefault →
  // coerce(defaultEmptyValue) → typed zero.
  private resolveValue(
    snapshot: GitSnapshot | null,
    field: GitField,
    varDefault: VarValue | undefined,
  ): VarValue {
    if (snapshot !== null) return snapshot[field] as VarValue;
    if (varDefault !== undefined) return varDefault;
    const type = GIT_FIELD_TYPE[field];
    try {
      return coerceToType(this.defaultEmptyValue, type);
    } catch {
      return zeroValue(type);
    }
  }
}

// ─── WatchManager ─────────────────────────────────────────────────────────────

// [LAW:single-enforcer] One fs.watch handle per path regardless of subscriber
// count.  Multiple shell/file variables can share one watcher on the same path.
class WatchManager {
  private readonly watchers = new Map<
    string,
    { watcher: FSWatcher; callbacks: Set<() => void> }
  >();

  subscribe(filePath: string, callback: () => void): () => void {
    let entry = this.watchers.get(filePath);
    if (!entry) {
      const callbacks = new Set<() => void>();
      let watcher: FSWatcher;
      try {
        watcher = fsWatch(filePath, () => {
          for (const cb of callbacks) cb();
        });
      } catch {
        // File may not exist yet; silently skip watch setup.
        return () => {};
      }
      entry = { watcher, callbacks };
      this.watchers.set(filePath, entry);
    }
    entry.callbacks.add(callback);
    return () => this.unsubscribe(filePath, callback);
  }

  private unsubscribe(filePath: string, callback: () => void): void {
    const entry = this.watchers.get(filePath);
    if (!entry) return;
    entry.callbacks.delete(callback);
    if (entry.callbacks.size === 0) {
      entry.watcher.close();
      this.watchers.delete(filePath);
    }
  }

  dispose(): void {
    for (const { watcher } of this.watchers.values()) watcher.close();
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

  // Infrastructure for shell/file/git source kinds:
  private readonly watchMgr = new WatchManager();
  private readonly ttlMgr = new TtlBucketManager();
  // [LAW:single-enforcer] One GitPoller per cwd — shared across all git
  // variables that target the same working directory.
  private readonly gitPollers = new Map<string, GitPoller>();
  // Collects all cleanup callbacks (TTL unsubscribes, watch unsubscribes,
  // MobX reaction disposers) so dispose() tears everything down in one call.
  private readonly cleanups: Array<() => void> = [];
  // Guards against concurrent executions of the same async source.
  private readonly inFlight = new Set<string>();
  // Shared engine instance — parse() is expensive; the engine is reused for
  // all key: template compilations.
  // [LAW:one-source-of-truth] One engine per registry, not one per variable.
  private readonly engine = createCcCandybarEngine();

  // defaultEmptyValue is the global fallback of last resort — the config-level
  // `default_empty_value` from the proposal. Defaults to empty string.
  constructor(
    private readonly store: VariableStore,
    private readonly defaultEmptyValue: VarValue = "",
  ) {}

  // ─── Synchronous source kinds ─────────────────────────────────────────────

  // literal: type inferred from value; box written once at declaration and never again.
  declareLiteral(name: string, value: VarValue): void {
    this.store.defineBox(name, typeOf(value), value);
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

  // shell: spawn command in /bin/sh; capture stdout; optional regex group-1 extract;
  // newlines → spaces. Box initialises to fallback; async execution fills it in.
  // [LAW:dataflow-not-control-flow] Box always holds a valid value; the cache
  // policy drives when it is refreshed, not whether the box exists.
  declareShell(name: string, command: string, opts: ShellOptions): void {
    this.store.defineBox(name, "string", this.stringInitial(opts.varDefault));
    const update = () =>
      void this.updateFromShell(name, command, opts.regex, opts.varDefault);
    update(); // initial run
    this.registerCachePolicy(name, opts.cache, update);
  }

  // file: read file at path; whole / first-line / regex group-1 extract; newlines → spaces.
  // Box initialises to fallback; async read fills it in.
  // [LAW:dataflow-not-control-flow] Same invariant as declareShell.
  declareFile(name: string, filePath: string, opts: FileOptions): void {
    this.store.defineBox(name, "string", this.stringInitial(opts.varDefault));
    const update = () =>
      void this.updateFromFile(
        name,
        filePath,
        opts.readMode,
        opts.regex,
        opts.varDefault,
      );
    update(); // initial run
    this.registerCachePolicy(name, opts.cache, update);
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
    this.store.defineComputed(name, "string", (_read) => {
      const scope = buildScope(this.store);
      try {
        const result = (parsedTpl.evaluate(scope) as RichText[])
          .map((f) => f.plain)
          .join("");
        this.lastErrors.delete(name);
        return result;
      } catch (e) {
        // [LAW:no-defensive-null-guards] Template eval failures (including
        // MobX cycle detection) surface as last_error; the box still holds
        // a safe fallback rather than propagating the throw to the renderer.
        this.recordError(name, e instanceof Error ? e.message : String(e));
        return this.stringInitial(opts.varDefault);
      }
    });
    // Force eager evaluation so any cycle is detected here (at config load)
    // rather than silently at the first render.  MobX keepAlive computeds are
    // otherwise lazy.
    this.store.read(name);
  }

  // time: current wall-clock time formatted with a Go reference-time layout.
  // Box initialises to the current time; the TTL timer refreshes it.
  // [LAW:dataflow-not-control-flow] Box always holds a valid formatted string.
  declareTime(name: string, opts: TimeOptions): void {
    const ttlMs = opts.ttlMs ?? 1_000;
    const format = (d: Date): string => {
      try {
        return formatGoTime(opts.format, d);
      } catch {
        return this.stringInitial(opts.varDefault);
      }
    };
    this.store.defineBox(name, "string", format(new Date()));
    const update = (): void => {
      try {
        this.store.setBox(name, formatGoTime(opts.format, new Date()));
        this.lastErrors.delete(name);
      } catch (e) {
        this.applyFallback(
          name,
          "string",
          opts.varDefault,
          e instanceof Error ? e.message : String(e),
        );
      }
    };
    const unsub = this.ttlMgr.subscribe(ttlMs, update);
    this.cleanups.push(unsub);
  }

  // git: first-class git fields backed by a shared GitPoller per cwd.
  // All git boxes for the same cwd share one set of git invocations, updated
  // atomically so all fields stay mutually consistent.
  // [LAW:dataflow-not-control-flow] Box always holds a valid typed value;
  // the watchers (.git/HEAD, .git/index) drive when it is refreshed.
  declareGit(name: string, opts: GitOptions): void {
    const type = GIT_FIELD_TYPE[opts.field];
    // Initialize to fallback; the async fetch will populate the real value.
    const initial =
      opts.varDefault !== undefined ? opts.varDefault : zeroValue(type);
    this.store.defineBox(name, type, initial);

    let poller = this.gitPollers.get(opts.cwd);
    if (!poller) {
      poller = new GitPoller(
        opts.cwd,
        this.store,
        this.defaultEmptyValue,
        this.watchMgr,
        this.cleanups,
      );
      this.gitPollers.set(opts.cwd, poller);
    }
    poller.addSubscriber(opts.field, name, opts.varDefault);
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

  // Whether a variable with this name has been declared.  Used by
  // declareHookDataInputs to skip auto-declaration for names already
  // declared by the user.
  has(name: string): boolean {
    return this.store.has(name);
  }

  // ─── Diagnostics ─────────────────────────────────────────────────────────

  // Returns the recorded error for a variable, or undefined if the last
  // resolution succeeded (or the variable has never been resolved).
  getLastError(name: string): LastError | undefined {
    return this.lastErrors.get(name);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  // Tear down all TTL timers, fs watchers, and MobX reactions registered by
  // async source kinds.  Call when the registry is no longer needed (e.g. on
  // daemon shutdown or config hot-reload).
  dispose(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    this.watchMgr.dispose();
    this.ttlMgr.dispose();
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
        const unsub = this.watchMgr.subscribe(policy.path, update);
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
        const disposer: IReactionDisposer = reaction(() => {
          const scope = buildScope(this.store);
          try {
            return (parsedKey.evaluate(scope) as RichText[])
              .map((f) => f.plain)
              .join("");
          } catch {
            return "";
          }
        }, update);
        this.cleanups.push(disposer);
        break;
      }

      case "depends_on": {
        // [LAW:dataflow-not-control-flow] reaction re-runs update whenever
        // any named variable changes.  Variability lives in the dep values,
        // not in whether the update executes — the update always runs when
        // the joined snapshot changes.
        const disposer: IReactionDisposer = reaction(
          () => policy.varNames.map((n) => String(this.store.read(n))).join(","),
          update,
        );
        this.cleanups.push(disposer);
        break;
      }
    }
  }

  private async updateFromShell(
    name: string,
    command: string,
    regex: string | undefined,
    varDefault: string | undefined,
  ): Promise<void> {
    if (this.inFlight.has(name)) return;
    this.inFlight.add(name);
    try {
      const { stdout, exitCode } = await execShell(command);
      if (exitCode !== 0) {
        this.applyFallback(
          name,
          "string",
          varDefault,
          `shell "${command}" exited with code ${exitCode}`,
        );
        return;
      }
      if (regex !== undefined) {
        const m = new RegExp(regex).exec(stdout);
        if (!m?.[1]) {
          this.applyFallback(
            name,
            "string",
            varDefault,
            `regex no-match in output of "${command}"`,
          );
          return;
        }
        this.store.setBox(name, m[1].replace(/\n/g, " "));
      } else {
        this.store.setBox(name, stdout.replace(/\n/g, " ").trim());
      }
      this.lastErrors.delete(name);
    } finally {
      this.inFlight.delete(name);
    }
  }

  private async updateFromFile(
    name: string,
    filePath: string,
    readMode: "whole" | "first-line" | undefined,
    regex: string | undefined,
    varDefault: string | undefined,
  ): Promise<void> {
    if (this.inFlight.has(name)) return;
    this.inFlight.add(name);
    try {
      const result = await readFileContent(filePath, readMode, regex);
      if (result.error !== undefined) {
        this.applyFallback(name, "string", varDefault, result.error);
        return;
      }
      this.store.setBox(name, result.content ?? "");
      this.lastErrors.delete(name);
    } finally {
      this.inFlight.delete(name);
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
}
