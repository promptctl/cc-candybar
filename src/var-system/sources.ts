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

import {
  compareStructural,
  computed,
  observable,
  observe,
  reaction,
  runInAction,
  type IComputedValue,
  type ObservableMap,
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
  isPending,
  pendingOf,
  type Outcome,
  type Present,
  type PayloadNode,
  type Pending,
  type Reading,
} from "../utils/outcome.js";
import type { SourceParse } from "./parse.js";
import { PendingValueError, readPending, type JsonValue } from "./types.js";
import type { SessionStateReader } from "../daemon/session-state.js";
import type { SessionId } from "../daemon/session-id.js";
import {
  keyHashOf,
  runOf,
  type ParserId,
  type ReadMode,
  type Run,
  type RunRefresh,
  type SourceRead,
} from "../facts/source-identity.js";
import { UNREAD_RUN, type RunFact } from "../facts/world-state.js";

export type { ReadMode } from "../facts/source-identity.js";

// The run a `shell` or `file` source names, or why it names none: pending
// while what its policy reads has not answered, failed while a key failed
// before answering.
export type SourceRun = Present<Run>;

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
// reads the bound view's session and dispatches through SessionStateReader.get.
export interface StateOptions {
  readonly key: string;
  readonly varDefault?: string;
}

// ─── Private infrastructure ───────────────────────────────────────────────────

// The publish half of a source, closed over its store node: takes what the
// run yielded, parsed, and writes the node — value or fallback.
type Publish = (outcome: Outcome<unknown>) => void;

// [LAW:one-source-of-truth] The parser's identity, without its default: what
// the run digests.
function parserIdOf(parse: SourceParse): ParserId {
  switch (parse.kind) {
    case "text":
      return { kind: "text" };
    case "regex":
      return { kind: "regex", pattern: parse.pattern };
    case "json":
      return { kind: "json" };
  }
}

// ─── Shared metadata ──────────────────────────────────────────────────────────

export interface LastError {
  readonly timestamp: number; // epoch ms, on the store's clock
  readonly message: string;
}

// What a registry's sources have published: each one's stored value, and the
// standing fault of each policy that cannot fire.
export interface Published {
  readonly values: readonly StoredValue[];
  readonly faults: readonly LastError[];
}

// [LAW:types-are-the-program] What a view's inputs are derived from: the value
// at each payload path as it stands — pending while its source has not
// answered — the reading of each run the view's sources name, by digest, as
// the host last read it, and the depth the view's renders draw at, which every
// contrast floor reads. A read is tracked, so an input moves in the turn its
// value does, and nothing else moves it.
export interface InputSource {
  session(): SessionId;
  read(path: string): Resolved;
  run(digest: string): RunFact;
  drawnAt(): ColorDepth;
}

// A registry no view source is bound to: a directory's, which reads no
// payload, or a view's before its source is bound — every input not answered,
// and its depth neither, so a key measuring a floor waits for the view's
// rather than running once at a depth no draw is at.
const UNBOUND: InputSource = {
  session: () => {
    throw new PendingValueError(
      "session_id",
      "the view's session has no value yet: no view source is bound",
    );
  },
  read: () => pendingOf("unread"),
  run: () => UNREAD_RUN,
  drawnAt: () => {
    throw new PendingValueError(
      "colorCompatibility.effective",
      "the drawn depth has no value yet: no view source is bound",
    );
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

// [LAW:parse-dont-validate] What a path through a payload found: a source that
// has not answered, or a value. The value is wrapped so a source's own JSON,
// which can spell anything, is never mistaken for the daemon's pending.
export type Resolved =
  | Pending
  | { readonly kind: "found"; readonly value: unknown };

export const found = (value: unknown): Resolved => ({ kind: "found", value });

// Recursively resolves a dotted path through a plain object.
// Finds undefined if any segment is absent or the traversed value is not an
// object. [LAW:types-are-the-program] A pending node is a source that has not
// answered yet, so every path through it is pending too: one `git: pending`
// is every `git.*` input not answered, never each one's default.
//
// A source's `ok` reading holds its document under `value`, and a document is
// the user's JSON: from there down nothing is tested for pending, because a
// file that says `{"kind":"pending"}` is a value.
export function resolvePath(obj: unknown, path: string): Resolved {
  let cur = obj as PayloadNode;
  let inDocument = false;
  for (const part of path.split(".")) {
    if (!inDocument && isPending(cur)) return cur;
    if (cur == null || typeof cur !== "object") return found(undefined);
    inDocument ||=
      part === "value" && (cur as { kind?: unknown }).kind === "ok";
    cur = (cur as Record<string, PayloadNode>)[part];
  }
  return !inDocument && isPending(cur) ? cur : found(cur);
}

// [LAW:parse-dont-validate] What a view's payload holds at a source's name,
// as the document's reading: the source's own outcome, pending while it has
// not answered, and a failure for anything else.
function sourceReading(name: string, resolved: Resolved): Reading<JsonValue> {
  if (resolved.kind === "pending") return resolved;
  const raw = resolved.value;
  if (raw === undefined) {
    return failed(
      `variable "${name}": the view's payload has no "${name}": its declaration did not take the source the config declares`,
      "read",
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
        "read",
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
  // [LAW:one-source-of-truth] What the host says a source's run cannot do,
  // the second half of its standing fault: the policy's map is written by
  // its policy, this one by the run's fault alone, so neither clears the
  // other's.
  private readonly runFaults = observable.map<string, LastError>(undefined, {
    deep: false,
  });

  // Collects all cleanup callbacks (MobX reaction disposers) so dispose()
  // tears everything down in one call.
  private readonly cleanups: Array<() => void> = [];
  // [LAW:one-source-of-truth] The run each `shell` and `file` source names,
  // by variable name: a derivation of its identity's inputs, pending while a
  // policy over values has nothing answered to name, failed while its key
  // failed before ever answering. A derivation, never a
  // value a reaction writes, so whoever reads the runs inside a batch — a
  // turn handed a world state from within the host's reaction — reads them as
  // the turn's input moved them. The host runs them (src/daemon/source-runs.ts),
  // and their readings come back through the view's input source.
  private readonly runs = observable.map<string, IComputedValue<SourceRun>>(
    undefined,
    { deep: false },
  );
  private readonly runSourcesNow = computed(
    (): ReadonlyMap<string, SourceRun> =>
      new Map([...this.runs].map(([name, run]) => [name, run.get()] as const)),
  );
  private readonly namedNow = computed(
    (): ReadonlyMap<string, Run> =>
      new Map(
        [...this.runSourcesNow.get()].flatMap(([name, run]) =>
          run.kind === "ok" ? [[name, run.value] as const] : [],
        ),
      ),
  );
  // Every `shell` and `file` source by variable name, with the run it names
  // or why it names none: what the render event counts, so a source whose key
  // never answers, or failed, is still told.
  runSources(): ReadonlyMap<string, SourceRun> {
    return this.runSourcesNow.get();
  }
  // The run each source names, by variable name: what a request waits on and
  // what names `check`'s stragglers.
  namedRuns(): ReadonlyMap<string, Run> {
    return this.namedNow.get();
  }
  // [LAW:one-source-of-truth] What this registry needs run, deduped by
  // digest, in digest order, so an output is the same whatever order a config
  // declares in. Computed and observed for the registry's life (the
  // constructor), so a turn in which nothing moved sorts nothing: a computed
  // read outside a reaction is derived again on every read.
  private readonly subscriptionsNow = computed((): readonly Run[] =>
    [
      ...new Map(
        [...this.namedNow.get().values()].map((run) => [run.digest, run]),
      ),
    ]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, run]) => run),
  );
  subscriptions(): readonly Run[] {
    return this.subscriptionsNow.get();
  }
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
      faults: [...this.standingFaults().values()],
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
    private readonly store: VariableStore,
    private readonly defaultEmptyValue: VarValue = "",
    sessionState?: SessionStateReader,
    // The directory home a session's view reads through to (`view()`).
    private readonly parent: SourceRegistry | null = null,
    // [LAW:one-source-of-truth] The environment an `env` source reads: the
    // daemon's host, handed in by whatever builds the registry. A registry built
    // without one reads every variable as unset, and says so on the source.
    private readonly env: Readonly<Record<string, string | undefined>> = {},
  ) {
    this.sessionState = sessionState;
    this.cleanups.push(observe(this.subscriptionsNow, () => {}));
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
      new VariableStore(this.store.clock, this.store),
      this.defaultEmptyValue,
      this.sessionState,
      this,
      this.env,
    );
  }

  // [LAW:one-source-of-truth] The registry IS the owner of its store — every
  // variable it declares lives there, and the renderer reads back through it.
  // Exposing it read-only lets a caller that already holds the registry obtain
  // the one store without threading a second reference that could diverge (the
  // action runtime reads current values from this exact store).
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
    this.store.defineDocument(name, failed(reason, "parse"));
  }

  // A plugin's source: a document derived from the reading its view's payload
  // carries at the source's own name — ok, absent or failed as the storage
  // owner read the session's file, or pending while it has not answered.
  // [LAW:no-silent-failure] A payload with nothing there is a declaration
  // that did not take the source the config declares: a bug, read as a failure
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
    const resolved = this.inputs.get().read(path);
    if (resolved.kind === "pending") {
      // Not answered yet is no failure: an earlier read's error no longer
      // stands for it.
      this.lastErrors.delete(name);
      throw new PendingValueError(
        name,
        `variable "${name}" has no value yet: its source has not answered`,
      );
    }
    const raw = resolved.value;
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

  // env: resolved once at declaration from the registry's environment; box written once, never again.
  // type is always 'string' — env vars are text by nature.
  declareEnv(name: string, envVar: string, varDefault?: string): void {
    const raw = this.env[envVar];
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
      { kind: "shell", command, cwd: opts.cwd },
      opts.cache,
      opts.parse,
    );
  }

  // file: read the file at path (whole, or its first line) as the text the
  // parser sees.
  declareFile(name: string, filePath: string, opts: FileOptions): void {
    this.declareSource(
      name,
      { kind: "file", path: filePath, readMode: opts.readMode ?? "whole" },
      opts.cache,
      opts.parse,
    );
  }

  // [LAW:single-enforcer] THE user-source declaration: the source's node, and
  // the one reaction that publishes into it the reading of the run it names,
  // as the view's input source has it (the host runs it: read → parse). The
  // cache policy names WHICH run, through the identity it names
  // (registerCachePolicy), never whether the node exists
  // [LAW:dataflow-not-control-flow].
  //
  // [LAW:types-are-the-program] Only an answered reading is published: the
  // node holds its fallback until the first run answers, and on a key's move
  // it holds the old run's answer until the new run's lands — the old `ok` is
  // simply not overwritten yet, so a key change draws no pending flash (spec
  // section 19).
  private declareSource(
    name: string,
    read: SourceRead,
    cache: CachePolicy,
    parse: SourceParse,
  ): void {
    const publish = this.publisherFor(name, parse);
    const refreshOf = this.registerCachePolicy(name, cache);
    // [LAW:single-enforcer] The one place a source's run is named: its digest
    // is taken here, as its identity moves. Equal by digest, so a source whose
    // run did not move keeps it, and its publish reaction is untouched.
    const run = computed(
      (): SourceRun => {
        const refresh = refreshOf();
        return refresh.kind === "ok"
          ? ok(
              runOf({ read, parse: parserIdOf(parse), refresh: refresh.value }),
            )
          : refresh;
      },
      // A failure is a failure whatever it says: its text is the variable's
      // standing fault, so a key throwing a moving message moves no run.
      {
        equals: (a, b) =>
          a.kind === "ok" && b.kind === "ok"
            ? a.value.digest === b.value.digest
            : a.kind === b.kind,
      },
    );
    runInAction(() => {
      this.sourceNames.push(name);
      this.runs.set(name, run);
    });
    this.cleanups.push(
      // The run's fault, as the host reads it (a watch that cannot hear its
      // path, a run the host refused), is the variable's standing fault for
      // as long as this source names that run.
      reaction(
        () => this.runFact(name)?.fault ?? null,
        (fault) =>
          this.noteFault(
            this.runFaults,
            name,
            fault === null ? ok(undefined) : failed(fault, "read"),
          ),
        { fireImmediately: true },
      ),
      reaction(
        () => this.runFact(name)?.reading,
        (reading) => {
          if (reading === undefined || reading.kind === "pending") return;
          // The instant the reading first differed is the world state's; the
          // store holds what the run answered.
          const { at: _at, ...outcome } = reading;
          publish(outcome);
        },
        { fireImmediately: true },
      ),
    );
  }

  // The reading of the run `name` names, or nothing while its policy names
  // none (one over values not answered yet).
  private runFact(name: string): RunFact | undefined {
    const run = this.runs.get(name)?.get();
    return run?.kind === "ok"
      ? this.inputs.get().run(run.value.digest)
      : undefined;
  }

  // [LAW:one-type-per-behavior] One total projection of the parser arm onto
  // the node it publishes: the text arms publish a string box, the json arm a
  // document. Selected once, at declaration — the pipeline never asks again.
  // The run parsed by the arm's own parser (source-runs.ts), so its value is
  // the arm's type.
  private publisherFor(name: string, parse: SourceParse): Publish {
    switch (parse.kind) {
      case "text":
      case "regex":
        return this.scalarPublisher(name, parse.default);
      case "json":
        return this.documentPublisher(name, parse.default);
    }
  }

  private scalarPublisher(
    name: string,
    varDefault: string | undefined,
  ): Publish {
    const fallback = this.stringInitial(varDefault);
    this.store.defineBox(name, "string", fallback);
    return (outcome) => {
      this.noteOutcome(name, outcome);
      this.store.setBox(name, orElse(outcome as Outcome<string>, fallback));
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
  // file, a command that failed, blank output — never for text that was read
  // and is not a document (failed in its parse phase): that is a broken
  // writer, and reads as its failure (⚠) whatever the default says
  // (brandon-plugins-ktag.8fv).
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
  ): Publish {
    // What the node holds before its first scan, and — with a default — what
    // stands in for a run that had nothing to read.
    const fallback: Reading<JsonValue> =
      varDefault === undefined ? pendingOf("unread") : ok(varDefault);
    this.store.defineDocument(name, fallback);
    let clearSettling: (() => void) | undefined;
    // Whether the document showing was READ (not the default standing in).
    let showingRead = false;
    this.cleanups.push(() => clearSettling?.());
    return (raw) => {
      clearSettling?.();
      const outcome = raw as Outcome<JsonValue>;
      this.noteOutcome(name, outcome);
      const readText =
        outcome.kind === "ok" ||
        (outcome.kind === "failed" && outcome.failedAt === "parse");
      const next = readText || varDefault === undefined ? outcome : fallback;
      const torn = showingRead && readText && outcome.kind !== "ok";
      const show = () => {
        showingRead = outcome.kind === "ok";
        this.store.setDocument(name, next);
      };
      if (torn) {
        clearSettling = this.store.clock.after(TORN_WRITE_SETTLE_MS, show);
      } else {
        show();
      }
    };
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
  // bound view's session (`session()`) and SessionState itself (MobX-tracked
  // via its internal atom). A click verb that mutates SessionState
  // invalidates this computed.
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
    this.store.defineComputed(name, "string", () => {
      // [LAW:parse-dont-validate] The view's checked session, the same one
      // the payload hands `session.id`.
      const value = sessionState.get(this.session(), opts.key);
      return value !== null ? value : fallback;
    });
  }

  // [LAW:one-source-of-truth] The revision of the session state this render's
  // `state` variables read (SessionStateReader.revision), found the way they
  // find it: through the session id the render was handed. A registry with no
  // session state reads none — one state that never changes.
  stateRevision(): number {
    return this.sessionState !== undefined
      ? this.sessionState.revision(this.session())
      : 0;
  }

  // The session the bound view draws for (InputSource.session): pending, as
  // every input is, before a view is bound.
  session(): SessionId {
    return this.inputs.get().session();
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
    const fault = this.standingFaults().get(name);
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
      ...this.standingFaults(),
    ]);
  }

  // Each variable's standing fault: its policy's, else its run's. A policy
  // that cannot fire names no run, so the two never stand together.
  private standingFaults(): ReadonlyMap<string, LastError> {
    return new Map([...this.runFaults, ...this.policyFaults]);
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
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    // The store's computeds are the last handles outward: a keepAlive computed
    // stays subscribed to the daemon-wide SessionState atom until released, and
    // that subscription held every disposed config's store for the life of the
    // daemon (brandon-unfiled-3248.t14). [LAW:single-enforcer] released here,
    // where every other handle a config holds is.
    return this.store.dispose();
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  // [LAW:single-enforcer] One place that maps every CachePolicy kind to the
  // refresh of the identity the source names: a period, a watched path or
  // nothing is the run's own refresh, fixed at declaration; a policy over what
  // the source reads is the hash of what that answered, pending until it
  // first answers. Adding a new policy kind means adding one case here.
  private registerCachePolicy(
    name: string,
    policy: CachePolicy,
  ): () => Present<RunRefresh> {
    switch (policy.kind) {
      case "never":
        return () => ok({ kind: "never" });

      case "ttl":
        return () => ok({ kind: "ttl", durationMs: policy.durationMs });

      case "watch_file":
        return () => ok({ kind: "watch_file", path: policy.path });

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
        return this.answeredUnder(name, () => {
          try {
            return ok(
              parsedKey
                .evaluate(buildScope(this.store))
                .map((f) => f.plain)
                .join(""),
            );
          } catch (e) {
            return readPending(e) !== undefined
              ? pendingOf("unread")
              : failed(
                  `cache key: ${e instanceof Error ? e.message : String(e)}`,
                  "read",
                );
          }
        });
      }

      case "depends_on": {
        // [LAW:dataflow-not-control-flow] The source re-reads whenever any
        // named variable changes. Variability lives in the dep values, not in
        // whether the update executes.
        return this.answeredUnder(name, (): Reading<string> => {
          const keys = policy.varNames.map((n) => this.store.changeKey(n));
          return keys.every((key) => key.kind === "ok")
            ? ok(keys.map((key) => key.value).join(","))
            : pendingOf("unread");
        });
      }
    }
  }

  // [LAW:one-type-per-behavior] Both policies over what a source reads — its
  // key, the variables it depends on — name the hash of the last value what
  // they read answered. Over a value not answered yet (a view's inputs before
  // its first payload) they name nothing (pending) rather than reading, so a first value
  // is one read, not a read under no value and another when the value arrives
  // (brandon-unfiled-3248.8ro6). One that throws, or reads a value not
  // answered, keeps the last answer, so a key failing for a moment and coming
  // back unchanged names nothing new; what it failed with is the variable's
  // standing fault (noteFault). One that has never answered names its
  // failure, so the render event says failed rather than unread.
  private answeredUnder(
    name: string,
    reads: () => Reading<string>,
  ): () => Present<RunRefresh> {
    // Equal by value, so an input that moved without moving what the policy
    // read hashes nothing and names the run it named.
    const answer = computed(reads, { equals: compareStructural });
    this.cleanups.push(
      reaction(
        () => answer.get(),
        (now) => this.noteFault(this.policyFaults, name, now),
        { fireImmediately: true },
      ),
    );
    // [LAW:dataflow-not-control-flow] exception: the last answer is kept in
    // the run's derivation, as a value a reaction wrote would lag the key's
    // move inside the host's batch. The registry observes its runs for its
    // life (the constructor), so this derivation runs at every answer.
    let last: string | undefined;
    return () => {
      const now = answer.get();
      if (now.kind === "ok") last = now.value;
      return last !== undefined
        ? ok({ kind: "key", hash: keyHashOf(last) })
        : now.kind === "failed"
          ? now
          : pendingOf("unread");
    };
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
    this.lastErrors.set(name, {
      timestamp: this.store.clock.now(),
      message,
    });
  }

  // The one fold from an outcome — whether the policy can fire, whether the
  // host can run the run — to the variable's standing fault in `faults`.
  // A fault standing for the same reason keeps its record, so it moves
  // nothing that draws it.
  private noteFault(
    faults: ObservableMap<string, LastError>,
    name: string,
    outcome: Reading<unknown>,
  ): void {
    runInAction(() => {
      if (outcome.kind !== "failed") faults.delete(name);
      else if (faults.get(name)?.message !== outcome.reason)
        faults.set(name, {
          timestamp: this.store.clock.now(),
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
