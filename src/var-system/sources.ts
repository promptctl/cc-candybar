// [LAW:one-source-of-truth] All payload ingestion goes through applyInput — no other path
// writes input-kind boxes. VariableStore owns reactivity; SourceRegistry owns source kinds.

import { launch } from "../proc/launch";
import { debug } from "../utils/logger";
import { readFile as fsReadFile } from "fs/promises";
import { watch as fsWatch, type FSWatcher } from "fs";
import { setInterval, clearInterval } from "timers";
import { reaction, type IReactionDisposer } from "mobx";
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
import type { JsonValue } from "./types.js";
import type { SessionStateReader } from "../daemon/session-state.js";

// [LAW:one-type-per-behavior] One union covers every cache policy; the config layer normalises strings (ttl:"5s") before declare*.
export type CachePolicy =
  | { readonly kind: "ttl"; readonly durationMs: number }
  | { readonly kind: "watch_file"; readonly path: string }
  | { readonly kind: "key"; readonly template: string }
  | { readonly kind: "depends_on"; readonly varNames: readonly string[] }
  | { readonly kind: "never" };

// [LAW:single-enforcer] Without this floor a `ttl: 50ms` against a 200ms command would
// silently overlap and stack up subprocesses. [LAW:no-mode-explosion] Not a config knob.
export const MIN_SHELL_TTL_MS = 500;

// [LAW:dataflow-not-control-flow] The floor applies only to `ttl`; the result is a function of the input policy and the constant.
function clampShellCache(name: string, policy: CachePolicy): CachePolicy {
  if (policy.kind !== "ttl") return policy;
  if (policy.durationMs >= MIN_SHELL_TTL_MS) return policy;
  debug(
    `declareShell "${name}": ttl ${policy.durationMs}ms below floor ${MIN_SHELL_TTL_MS}ms; clamping`,
  );
  return { kind: "ttl", durationMs: MIN_SHELL_TTL_MS };
}

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

// [LAW:decomposition] A user source is a READER (what text arrives) and a PARSER (what value
// it becomes) — orthogonal data. The fallback lives in the parser arm's output domain.
export interface ShellOptions {
  readonly cache: CachePolicy;
  readonly parse: SourceParse;
}

export type ReadMode = "whole" | "first-line";

export interface FileOptions {
  readonly readMode?: ReadMode;
  readonly cache: CachePolicy;
  readonly parse: SourceParse;
}

export interface TemplateOptions {
  readonly varDefault?: string;
}

export interface TimeOptions {
  // Go reference-time layout. Reference time: Mon Jan 2 15:04:05 MST 2006
  readonly format: string;
  readonly ttlMs?: number;
  readonly varDefault?: string;
}

export type GitField =
  | "branch"
  | "sha"
  | "dirty"
  | "ahead"
  | "behind"
  | "stash";

export interface GitOptions {
  readonly field: GitField;
  readonly cwd: string;
  readonly varDefault?: VarValue;
}

// [LAW:one-source-of-truth] state vars read through to SessionState, whose internal atom owns the reactive contract.
export interface StateOptions {
  readonly key: string;
  readonly varDefault?: string;
}

// [LAW:one-source-of-truth] The name a config gives the hook payload's session_id; state
// vars resolve "which session am I in" from it. [LAW:no-mode-explosion] No per-decl override.
export const SESSION_ID_VAR_NAME = "session.id";

// [LAW:effects-at-boundaries] A reader classifies its own failure as a value, and `where` names
// the text's origin. A cancelled read rejects with the signal's reason — the one expected rejection.
interface SourceReader {
  readonly where: string;
  read(): Promise<Outcome<string>>;
}

function shellReader(command: string, signal: AbortSignal): SourceReader {
  return {
    where: `output of "${command}"`,
    read: async () => {
      const r = await launch({
        bin: "/bin/sh",
        args: ["-c", command],
        category: "user-shell",
        signal,
      });
      if (!r.ok && r.reason === "aborted") throw signal.reason;
      if (r.ok) return ok(r.stdout);
      const why =
        r.exitCode === null
          ? [r.reason, r.error].filter((s) => s !== undefined).join(": ")
          : `exited with code ${r.exitCode}`;
      return failed(`shell "${command}" ${why}`);
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

function parsed<V>(
  read: Outcome<string>,
  parser: Parser<V>,
  where: string,
): Outcome<V> {
  if (read.kind !== "ok") return read;
  const out = parser(read.value);
  return out.kind === "failed" ? failed(`${out.reason} in ${where}`) : out;
}

type Publish = (read: Outcome<string>) => void;

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

// [LAW:single-enforcer] One Go-reference-time formatter for every time source. Tokens match
// longest-first in one left-to-right pass, so "January" never conflicts with "Jan".
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

const GIT_FIELD_TYPE: Readonly<Record<GitField, VarType>> = {
  branch: "string",
  sha: "string",
  dirty: "boolean",
  ahead: "number",
  behind: "number",
  stash: "number",
};

// [LAW:one-source-of-truth] The only mapping from GitInfo to var-system's six-field model; the provider owns the cache, the watcher and the launch category.

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
      // GitService emits the literal "detached" off-branch and var-system's contract is "" — a branch actually named "detached" is the same old ambiguity.
      return info.branch === "detached" ? "" : info.branch;
    // [LAW:dataflow-not-control-flow] This surface renders only values, so absent and failed both collapse to the typed zero.
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

// [LAW:single-enforcer] One fs.watch handle per path, however many subscribers share it.
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

// [LAW:single-enforcer] One setInterval per unique TTL duration, shared by every variable at that interval.
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

export interface LastError {
  readonly timestamp: number;
  readonly message: string;
}

interface InputMeta {
  readonly path: string;
  readonly varDefault: VarValue | undefined;
}

function resolvePath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function coerceToType(raw: unknown, type: VarType): VarValue {
  // [LAW:no-defensive-null-guards] Trust boundary: a non-primitive payload value is malformed input — fail loudly.
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

function zeroValue(type: VarType): VarValue {
  if (type === "number") return 0;
  if (type === "boolean") return false;
  return "";
}

// [LAW:single-enforcer] One SourceRegistry per daemon: two on one store would duplicate input-box definitions.

export class SourceRegistry {
  private readonly inputMetas = new Map<string, InputMeta>();
  private readonly lastErrors = new Map<string, LastError>();

  private readonly watchMgr = new WatchManager();
  private readonly ttlMgr = new TtlBucketManager();
  // [LAW:single-enforcer] One subscription per cwd; the provider shares one watcher and cache entry across N subscribers in a repo.
  private readonly gitSubscriptions = new Map<
    string,
    {
      fieldSubs: Map<
        GitField,
        Array<{ name: string; varDefault: VarValue | undefined }>
      >;
      unsubscribe: () => void;
    }
  >();
  private readonly cleanups: Array<() => void> = [];
  // [LAW:no-ambient-temporal-coupling] One run per source at a time (a refresh firing mid-run
  // is dropped); `settled()` is the explicit "every run completed" state a caller awaits.
  private readonly inFlight = new Map<string, Promise<void>>();
  // [LAW:single-enforcer] The registry owns every async handle its sources hold, the children
  // included: dispose() aborts them, so no run outlives the registry that started it.
  private readonly abort = new AbortController();
  private readonly engine = createCcCandybarEngine();

  private readonly gitProvider: GitDataProvider;
  private readonly ownsGitProvider: boolean;
  // [LAW:locality-or-seam] Injected so tests can fake it; absent outside the daemon, where declareState() rejects loudly.
  private readonly sessionState: SessionStateReader | undefined;

  // gitProvider and sessionState let the daemon inject its shared instances; omitted, a private provider is built. defaultEmptyValue is the last-resort fallback.
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

  get variableStore(): VariableStore {
    return this.store;
  }

  declareLiteral(name: string, value: VarValue): void {
    this.store.defineBox(name, typeOf(value), value);
  }

  declareInput(
    name: string,
    path: string,
    type: VarType,
    varDefault?: VarValue,
  ): void {
    // [LAW:dataflow-not-control-flow] Initialize to the fallback so the box always holds a valid typed value.
    const initial =
      varDefault !== undefined ? varDefault : this.defaultFor(type);
    this.store.defineBox(name, type, initial);
    this.inputMetas.set(name, { path, varDefault });
  }

  declareEnv(name: string, envVar: string, varDefault?: string): void {
    const raw = process.env[envVar];
    if (raw !== undefined) {
      this.store.defineBox(name, "string", raw);
      return;
    }
    const fallback =
      varDefault !== undefined
        ? varDefault
        : typeof this.defaultEmptyValue === "string"
          ? this.defaultEmptyValue
          : "";
    this.store.defineBox(name, "string", fallback);
    this.recordError(name, `env var "${envVar}" is not set`);
  }

  declareShell(name: string, command: string, opts: ShellOptions): void {
    this.declareSource(
      name,
      shellReader(command, this.abort.signal),
      clampShellCache(name, opts.cache),
      opts.parse,
    );
  }

  declareFile(name: string, filePath: string, opts: FileOptions): void {
    this.declareSource(
      name,
      fileReader(filePath, opts.readMode ?? "whole", this.abort.signal),
      opts.cache,
      opts.parse,
    );
  }

  // [LAW:single-enforcer] THE user-source pipeline: read → parse → publish; shell/file are two readers
  // through it, text/regex/json three parsers. The policy drives WHEN it refreshes, never whether it exists.
  private declareSource(
    name: string,
    reader: SourceReader,
    cache: CachePolicy,
    parse: SourceParse,
  ): void {
    const publish = this.publisherFor(name, parse, reader.where);
    const update = () => this.runSource(name, reader, publish);
    update();
    this.registerCachePolicy(name, cache, update);
  }

  // [LAW:one-type-per-behavior] One total projection of the parser arm onto the node it publishes, selected once at declaration.
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

  // Without a default the node holds the failure itself, which the scope proxy surfaces as an
  // error naming the variable [LAW:no-silent-failure] — a document has no honest empty value.
  private documentPublisher(
    name: string,
    varDefault: JsonValue | undefined,
    where: string,
  ): Publish {
    const fallback: Outcome<JsonValue> =
      varDefault === undefined ? ABSENT : ok(varDefault);
    this.store.defineDocument(name, fallback);
    return (read) => {
      const outcome = parsed(read, jsonParser, where);
      this.noteOutcome(name, outcome);
      this.store.setDocument(
        name,
        outcome.kind === "ok" || varDefault === undefined ? outcome : fallback,
      );
    };
  }

  private runSource(
    name: string,
    reader: SourceReader,
    publish: Publish,
  ): void {
    if (this.inFlight.has(name)) return;
    // [LAW:no-silent-failure] The registry's own abort is the one rejection a run may end in; any other stays unhandled and loud.
    const run = reader
      .read()
      .then(publish, (err: unknown) => {
        if (err !== this.abort.signal.reason) throw err;
      })
      .finally(() => this.inFlight.delete(name));
    this.inFlight.set(name, run);
  }

  // [LAW:no-ambient-temporal-coupling] Resolves when every shell/file run in flight — and every run
  // one triggered — completes, or at the deadline. A git subscription's first delivery is not a run.
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

  // [LAW:dataflow-not-control-flow] MobX auto-tracks every store.read() the template makes, so the invalidation graph builds itself.
  declareTemplate(
    name: string,
    template: string,
    opts: TemplateOptions = {},
  ): void {
    // Parse once at declaration, so an invalid template fails at config load, not at first render.
    const parsedTpl = this.engine.parse(template);
    this.store.defineComputed(name, "string", (_read) => {
      const scope = buildScope(this.store);
      try {
        const result = parsedTpl
          .evaluate(scope)
          .map((f) => f.plain)
          .join("");
        this.lastErrors.delete(name);
        return result;
      } catch (e) {
        // [LAW:no-defensive-null-guards] Eval failures (MobX cycle detection included) surface as last_error; the box keeps a safe fallback.
        this.recordError(name, e instanceof Error ? e.message : String(e));
        return this.stringInitial(opts.varDefault);
      }
    });
    // Force eager evaluation so a cycle is caught at config load; keepAlive computeds are otherwise lazy.
    this.store.read(name);
  }

  // [LAW:dataflow-not-control-flow] The box always holds a valid formatted string; the TTL timer refreshes it.
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

  // git: all boxes for one cwd ride one provider subscription, which collapses N subscribers in
  // a repo onto one watcher + cache entry that drives when the snapshot is refreshed.
  declareGit(name: string, opts: GitOptions): void {
    const type = GIT_FIELD_TYPE[opts.field];
    // [LAW:single-enforcer] The schema constrains `default` to string, so coerce it to the field's native type before defineBox sees it.
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
      const unsubscribe = this.gitProvider.subscribe(opts.cwd, (info) => {
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
      sub = { fieldSubs, unsubscribe };
      this.gitSubscriptions.set(opts.cwd, sub);
    }

    let fieldList = sub.fieldSubs.get(opts.field);
    if (!fieldList) {
      fieldList = [];
      sub.fieldSubs.set(opts.field, fieldList);
    }
    fieldList.push({ name, varDefault: opts.varDefault });
  }

  // state: the computed reads two deps — the canonical session-id input var and SessionState's own atom — so a click verb and a per-render id change both invalidate it.
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
      // [LAW:types-are-the-program] Redeclaring session.id as a non-string variable yields empty state lookups — loud by absence, never silently coerced.
      const sessionId = read(SESSION_ID_VAR_NAME);
      if (typeof sessionId !== "string" || !sessionId) return fallback;
      const value = sessionState.get(sessionId, opts.key);
      return value !== null ? value : fallback;
    });
  }

  // [LAW:dataflow-not-control-flow] One runInAction so dependents invalidate exactly once, and every input box is refreshed every render.
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

  getLastError(name: string): LastError | undefined {
    return this.lastErrors.get(name);
  }

  dispose(): void {
    this.abort.abort();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    for (const sub of this.gitSubscriptions.values()) sub.unsubscribe();
    this.gitSubscriptions.clear();
    this.watchMgr.dispose();
    this.ttlMgr.dispose();
    if (this.ownsGitProvider) this.gitProvider.close();
  }

  // [LAW:single-enforcer] One place mapping every CachePolicy kind to its trigger mechanism.
  private registerCachePolicy(
    name: string,
    policy: CachePolicy,
    update: () => void,
  ): void {
    switch (policy.kind) {
      case "never":
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
        // [LAW:dataflow-not-control-flow] The rendered key template is the sole selector: the source recomputes whenever it changes.
        const parsedKey = this.engine.parse(policy.template);
        const disposer: IReactionDisposer = reaction(() => {
          const scope = buildScope(this.store);
          try {
            return parsedKey
              .evaluate(scope)
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
        const disposer: IReactionDisposer = reaction(
          () => policy.varNames.map((n) => this.store.changeKey(n)).join(","),
          update,
        );
        this.cleanups.push(disposer);
        break;
      }
    }
  }

  // [LAW:no-defensive-null-guards] Failure chain: per-variable default → defaultEmptyValue coerced → zero, whose backstop is deliberate — the caller already recorded the error.
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

  private defaultFor(type: VarType): VarValue {
    try {
      return coerceToType(this.defaultEmptyValue, type);
    } catch {
      return zeroValue(type);
    }
  }

  private stringInitial(varDefault: string | undefined): string {
    if (varDefault !== undefined) return varDefault;
    if (typeof this.defaultEmptyValue === "string")
      return this.defaultEmptyValue;
    return "";
  }

  private recordError(name: string, message: string): void {
    this.lastErrors.set(name, { timestamp: Date.now(), message });
  }

  private noteOutcome(name: string, outcome: Outcome<unknown>): void {
    if (outcome.kind === "ok") this.lastErrors.delete(name);
    else
      this.recordError(
        name,
        outcome.kind === "failed" ? outcome.reason : "no value",
      );
  }
}
