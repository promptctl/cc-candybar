// [LAW:one-source-of-truth] The daemon's MobX store is THE place where
// every variable's value lives. Templates, segments, and click handlers
// all read through this store; there is no parallel cache, no shadow
// state, no per-renderer copy.
//
// Two node kinds — `box` for externally-driven values (input JSON,
// shell output, fs watchers, TTL timers) and `computed` for derived
// values (templates, git fields wrapping shell). MobX auto-tracks
// dependencies when a computed's deriver reads other variables; the
// invalidation graph is built without us declaring it.

import {
  observable,
  computed,
  runInAction as mobxRunInAction,
  type IObservableValue,
  type IComputedValue,
} from "mobx";
import {
  toDocument,
  typeOf,
  type JsonValue,
  type VarType,
  type VarValue,
} from "./types";
import type { Outcome } from "../utils/outcome.js";

// [LAW:types-are-the-program] How the store holds a derived value. A
// `computed` keeps its answer until what it read changes. A `projection` reads
// the instant of the draw in progress (brandon-unfiled-3248.8ro6, step 6), which
// changes every frame, so the store keeps no answer for it: every read derives
// it again. Which one a variable is, is the projection fold's to say
// (src/config/loader/projections.ts) — and since whatever reads a projection is
// one, no computed ever caches an instant.
export type Derivation = "computed" | "projection";

export interface VarNode {
  readonly name: string;
  readonly type: VarType;
  readonly kind: "box" | Derivation;
  read(): VarValue;
  // [LAW:types-are-the-program] Age is a property of the node, not of an
  // external bookkeeping layer — duplicating it in a side map would let the
  // two diverge. `number` for box nodes (epoch ms of last set, including the
  // initial-value set at construction); `null` for computed nodes, whose
  // freshness is governed by MobX invalidation, not a single timestamp.
  lastUpdatedMs(): number | null;
}

class BoxNode implements VarNode {
  readonly kind = "box" as const;
  private readonly cell: IObservableValue<VarValue>;
  // [LAW:single-enforcer] One write path (`set`) updates both the value and
  // the timestamp; introspection reads from the same place renderers do.
  //
  // It records when the value last CHANGED, which is what debug.ts calls the
  // node's age and what anyone reading that age is asking (brandon-var-system-
  // 1tl). Stamping every write instead reported attempts, and reported them most
  // misleadingly in the one situation where the age is consulted: a source
  // re-running with no effect.
  private lastChangedAt: number;

  constructor(
    readonly name: string,
    readonly type: VarType,
    initial: VarValue,
  ) {
    assertType(name, type, initial, "initial value");
    this.cell = observable.box(initial, { deep: false });
    this.lastChangedAt = Date.now();
  }

  read(): VarValue {
    return this.cell.get();
  }

  set(value: VarValue): void {
    assertType(this.name, this.type, value, "set value");
    // [LAW:single-enforcer] ONE comparison decides both halves of a write:
    // whether observers hear about it (they do not, because an unchanged value is
    // never written) and whether the age moved. Configuring the box's own
    // `equals` beside this would be a second mechanism for the same decision —
    // and a dead one, since `set` is the only writer and never hands the cell an
    // equal value. A mutation proved it dead rather than an argument: inverting
    // that `equals` changed no test.
    if (Object.is(this.cell.get(), value)) return;
    this.cell.set(value);
    this.lastChangedAt = Date.now();
  }

  lastUpdatedMs(): number {
    return this.lastChangedAt;
  }
}

// What MobX's ComputedValue keeps private: the keepAlive flag its teardown is
// guarded by, and the teardown itself (`suspend_`: unsubscribe from every
// dependency and drop the cached value). The computed the public `computed()`
// returns is this object; the type names the two members `release` reaches.
interface KeepAliveComputed<T> extends IComputedValue<T> {
  keepAlive_: boolean;
  suspend_(): void;
}

// [LAW:one-type-per-behavior] A value the store derives, whatever it is a
// value of: a variable (ComputedNode, ProjectionNode), or a template a draw
// evaluates (a placement's parts, src/dsl/parts.ts). Read is the whole of it.
export interface Derived<T> {
  read(): T;
}

// A derived value that keeps its answer until what it read changes, and is
// released with the store that holds it.
class Kept<T> implements Derived<T> {
  private readonly cell: KeepAliveComputed<T>;

  constructor(name: string, deriver: () => T) {
    // [LAW:one-source-of-truth] keepAlive caches the value across reads
    // so `.get()` re-runs the deriver only when a tracked dep
    // invalidates — without it, MobX treats an unobserved computed as
    // "not cached" and re-runs on every read. The render path is pull-
    // only (no autorun), so keepAlive is the only mode that gives the
    // reactive-cache contract the proposal promises.
    this.cell = computed(deriver, {
      keepAlive: true,
    }) as KeepAliveComputed<T>;
    // [LAW:no-silent-failure] A MobX whose computed no longer tears itself
    // down this way — or guards the teardown by another flag, so lifting this
    // one leaves `suspend_` a no-op — would leak every disposed store again,
    // quietly, until the RSS backstop fired. Throw instead: registerDslConfig
    // folds a declaration's throw into a load warning per variable, so the
    // first such build shows the message on every computed's ⚠ cell.
    if (typeof this.cell.suspend_ !== "function") {
      throw new TypeError(
        `Variable "${name}": this MobX's computed has no suspend_; release() cannot unsubscribe it`,
      );
    }
    if (typeof this.cell.keepAlive_ !== "boolean") {
      throw new TypeError(
        `Variable "${name}": this MobX's computed has no keepAlive_ flag; release() cannot lift it`,
      );
    }
  }

  read(): T {
    return this.cell.get();
  }

  // Unsubscribe from every dependency and drop the cached value. A keepAlive
  // computed never does this on its own — MobX keeps it subscribed to whatever
  // it read for as long as those observables live, which for a daemon-wide
  // observable (the SessionState atom) is the life of the daemon, and that
  // subscription kept every disposed config's whole store reachable
  // (brandon-unfiled-3248.t14). MobX offers no public release for a keepAlive
  // computed, so this lifts the guard its own teardown checks and runs that
  // teardown. Must run inside an action: the unobservation it cascades is
  // settled when the outermost batch ends.
  // [LAW:single-enforcer] exception: two MobX internals (`keepAlive_`,
  // `suspend_`) are reached here and nowhere else; the constructor refuses a
  // MobX without them, and test/var-store-dispose.test.ts pins the effect.
  release(): void {
    this.cell.keepAlive_ = false;
    this.cell.suspend_();
  }
}

// A derived value with no answer to keep: each read runs its deriver, at the
// draw in progress. Nothing cached reads one, so it has nothing to release.
class Projected<T> implements Derived<T> {
  constructor(private readonly deriver: () => T) {}

  read(): T {
    return this.deriver();
  }
}

class ComputedNode implements VarNode {
  readonly kind = "computed" as const;
  private readonly cell: Kept<VarValue>;

  constructor(
    readonly name: string,
    readonly type: VarType,
    deriver: () => VarValue,
  ) {
    this.cell = new Kept(name, () => {
      const v = deriver();
      assertType(this.name, this.type, v, "computed result");
      return v;
    });
  }

  read(): VarValue {
    return this.cell.read();
  }

  release(): void {
    this.cell.release();
  }

  lastUpdatedMs(): null {
    // [LAW:no-defensive-null-guards] Computed nodes have no single
    // "updated" moment — the cache is valid until a tracked dep changes.
    // Returning null is structurally distinct from "updated at 0," so a
    // consumer can render "—" for computed and a real age for boxes.
    return null;
  }
}

// A projection holds no value: each read runs its deriver, at the draw in
// progress. Nothing cached reads one, so it has no subscriptions to release.
class ProjectionNode implements VarNode {
  readonly kind = "projection" as const;
  private readonly cell: Projected<VarValue>;

  constructor(
    readonly name: string,
    readonly type: VarType,
    deriver: () => VarValue,
  ) {
    this.cell = new Projected(() => {
      const v = deriver();
      assertType(this.name, this.type, v, "projection result");
      return v;
    });
  }

  read(): VarValue {
    return this.cell.read();
  }

  lastUpdatedMs(): null {
    // Derived on every read: it has no age.
    return null;
  }
}

// [LAW:types-are-the-program] A document node: the namespace a `parse: { json }`
// source publishes. It holds an Outcome, never a bare document — "not yet
// scanned" (absent) and "the scan failed: <why>" (failed) are states a
// template read must see, so the failure travels WITH the value to the one
// place that unwraps it (the scope proxy, src/template-engine/scope.ts) and
// surfaces there naming the variable. A scalar box has no such states: its
// fallback is a string. Every ok value is shaped by toDocument on the way IN —
// the one place the document invariant (null prototypes, sorted keys) is
// enforced, for a scan's output and an authored default alike
// [LAW:single-enforcer].
//
// Equality is by CONTENT (documentKey), not by identity: `toDocument` rebuilds a
// fresh object on every scan, so an identity comparison made a `json` source that
// re-read byte-identical bytes wake every observer of the document — while
// `changeKey`, whose own comment explains why it compares structurally, said the
// same rescan was not a change. Two answers to "did this document change" that
// disagreed; they are one function now (brandon-var-system-1tl).
export interface DocumentNode {
  readonly name: string;
  readonly kind: "document";
  read(): Outcome<JsonValue>;
  lastUpdatedMs(): number;
}

class DocumentCell implements DocumentNode {
  readonly kind = "document" as const;
  private readonly cell: IObservableValue<Outcome<JsonValue>>;
  private lastChangedAt: number;

  constructor(
    readonly name: string,
    initial: Outcome<JsonValue>,
  ) {
    this.cell = observable.box(shaped(initial), { deep: false });
    this.lastChangedAt = Date.now();
  }

  read(): Outcome<JsonValue> {
    return this.cell.get();
  }

  set(value: Outcome<JsonValue>): void {
    const next = shaped(value);
    // [LAW:single-enforcer] As in BoxNode: one comparison, and not writing IS
    // the notification rule. An unchanged rescan reaches no observer because the
    // cell is never handed the value, so the box needs no `equals` of its own to
    // enforce what this line already decided.
    if (sameDocument(this.cell.get(), next)) return;
    this.cell.set(next);
    this.lastChangedAt = Date.now();
  }

  lastUpdatedMs(): number {
    return this.lastChangedAt;
  }
}

// [LAW:one-source-of-truth] THE answer to "are these the same document" — the
// document box's equality, its age, and `changeKey` are all this one expression.
// Canonical because every stored document has sorted keys and null prototypes
// (toDocument), so a rescan that produced the same content in another key order
// keys identically; total because the non-ok arms are values too (two failures
// for the same reason are not a change, a new reason is).
export function documentKey(outcome: Outcome<JsonValue>): string {
  return JSON.stringify(outcome);
}

function sameDocument(a: Outcome<JsonValue>, b: Outcome<JsonValue>): boolean {
  return documentKey(a) === documentKey(b);
}

function shaped(outcome: Outcome<JsonValue>): Outcome<JsonValue> {
  return outcome.kind === "ok"
    ? { kind: "ok", value: toDocument(outcome.value) }
    : outcome;
}

// [LAW:one-type-per-behavior] Every node the store holds. `read`'s result type
// is the discriminator's payload: a VarNode reads a VarValue, a DocumentNode
// an Outcome<JsonValue>; a consumer that must be total over both (the scope
// proxy, debug introspection) switches on `kind` once.
export type StoreNode = VarNode | DocumentNode;

function assertType(
  name: string,
  declared: VarType,
  value: VarValue,
  context: string,
): void {
  const actual = typeOf(value);
  if (actual !== declared) {
    throw new TypeError(
      `Variable "${name}": ${context} type ${actual} does not match declared type ${declared}`,
    );
  }
}

// [LAW:one-source-of-truth] Every variable lives in ONE store, the home its
// scope names (brandon-unfiled-3248.8ro6, step 2): a directory's store holds
// the sources no session value reaches, and each session's view is a store of
// its own over it — `parent` — holding the session's inputs, state and
// derivations. A view READS through to its parent and declares and writes only
// its own nodes, so no session's write lands in another session's values, and
// a directory value is one node however many sessions read it.

export class VariableStore {
  constructor(private readonly parent: VariableStore | null = null) {}

  // [LAW:no-ambient-temporal-coupling] Which names are declared is itself
  // observable: a reaction that read a name before its declaration (a cache
  // key over a variable declared after it) re-runs when it is declared, so
  // what it sees does not depend on the order the config lists variables in.
  // `deep: false` keeps each node the object it was declared as.
  private readonly nodes = observable.map<string, StoreNode>(undefined, {
    deep: false,
  });

  defineBox(name: string, type: VarType, initial: VarValue): void {
    this.declare(name, new BoxNode(name, type, initial));
  }

  defineDocument(name: string, initial: Outcome<JsonValue>): void {
    this.declare(name, new DocumentCell(name, initial));
  }

  // Computed deriver receives a `read` function that returns the value
  // of any variable in the store. Calling `read(other)` from inside the
  // deriver is what registers the dependency with MobX — the deriver's
  // body is the dep graph.
  defineComputed(
    name: string,
    type: VarType,
    deriver: (read: (other: string) => VarValue) => VarValue,
  ): void {
    this.defineDerived(name, type, "computed", deriver);
  }

  defineDerived(
    name: string,
    type: VarType,
    derivation: Derivation,
    deriver: (read: (other: string) => VarValue) => VarValue,
  ): void {
    const reader = (other: string): VarValue => this.read(other);
    const Node = derivation === "computed" ? ComputedNode : ProjectionNode;
    this.declare(name, new Node(name, type, () => deriver(reader)));
  }

  // A derived value of this store that is no variable — a template a draw
  // evaluates (src/dsl/parts.ts) — held as a variable's would be: kept until
  // what it read changes, or derived at every read, and released with them.
  derive<T>(
    name: string,
    derivation: Derivation,
    deriver: () => T,
  ): Derived<T> {
    this.refuseDisposed(`Derived value "${name}"`);
    if (derivation === "projection") return new Projected(deriver);
    const kept = new Kept(name, deriver);
    this.kept.push(kept);
    return kept;
  }

  private readonly kept: Array<Kept<unknown>> = [];

  read(name: string): VarValue {
    return this.requireVar(name).read();
  }

  readDocument(name: string): Outcome<JsonValue> {
    const node = this.requireNode(name);
    if (node.kind !== "document") {
      throw new TypeError(
        `Variable "${name}" is a ${node.kind}, not a document`,
      );
    }
    return node.read();
  }

  setDocument(name: string, value: Outcome<JsonValue>): void {
    const node = this.requireOwn(name);
    if (node.kind !== "document") {
      throw new TypeError(
        `Variable "${name}" is a ${node.kind}, not a document (use defineDocument to create one)`,
      );
    }
    mobxRunInAction(() => (node as DocumentCell).set(value));
  }

  setBox(name: string, value: VarValue): void {
    const node = this.requireOwn(name);
    if (node.kind !== "box") {
      throw new TypeError(
        `Variable "${name}" is a ${node.kind}, not a box (use defineBox to create a settable variable)`,
      );
    }
    // [LAW:single-enforcer] All mutations go through one action. MobX
    // strict-mode (the default in v6) rejects modifications outside an
    // action once the observable has observers — and our keepAlive
    // computeds always do. Wrapping setBox here means callers do not
    // need to remember; runInAction stays useful for batching multiple
    // sets so dependents invalidate once.
    mobxRunInAction(() => (node as BoxNode).set(value));
  }

  // Wrap multi-variable updates so dependents only invalidate once per
  // batch. Used by the render path to push a whole input payload before
  // any computed re-evaluates.
  runInAction(fn: () => void): void {
    mobxRunInAction(fn);
  }

  has(name: string): boolean {
    return this.nodes.has(name) || (this.parent?.has(name) ?? false);
  }

  getType(name: string): VarType {
    return this.requireVar(name).type;
  }

  getKind(name: string): StoreNode["kind"] {
    return this.requireNode(name).kind;
  }

  // [LAW:one-source-of-truth] A string that changes exactly when the node's
  // value does — the ONE spelling a change-driven reaction (a `depends_on`
  // cache policy) compares, total over node kinds so a document can be
  // depended on like a scalar. Structural for documents: every stored
  // document has sorted keys (toDocument), so a rescan yielding the same
  // content in another key order is not a change.
  changeKey(name: string): string {
    const node = this.requireNode(name);
    if (node.kind === "document") return documentKey(node.read());
    // A scalar read can throw: a `template` variable with no authored `default`
    // reads as its failure (brandon-var-sources-1p6). Failing IS a change — a
    // dependant must re-run when its dependency stops producing a value — and a
    // key derived from the reason keeps it one: ok → failed differs, and two
    // consecutive failures for the same reason do not. Letting the throw escape
    // would instead break the reaction that asked, which is the one consumer
    // with no way to recover. [LAW:no-silent-failure] the failure is carried in
    // the key, not swallowed.
    try {
      return String(node.read());
    } catch (e) {
      return ` failed:${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // [LAW:types-are-the-program] Introspection (src/daemon/debug.ts) needs
  // the whole node — type, kind, lastUpdatedMs — in one lookup, but
  // returning the BoxNode directly would leak `.set` structurally even
  // though VarNode does not advertise it. The returned wrapper is a fresh
  // object exposing only the VarNode surface — `.set` is unreachable at
  // any level (no structural escape, no plain-JS reach-through). The
  // mutation path remains gated behind `setBox`, which wraps in
  // runInAction to satisfy MobX strict-mode.
  //
  // [LAW:single-enforcer] One requireNode call per consumer-row — the
  // round-1 dedup fix in introspectVars relies on the caller getting both
  // type/kind and a read() in one go without paying for a second
  // requireNode. The wrapper preserves that.
  getNode(name: string): StoreNode {
    const node = this.requireNode(name);
    return node.kind === "document"
      ? {
          name: node.name,
          kind: node.kind,
          read: () => node.read(),
          lastUpdatedMs: () => node.lastUpdatedMs(),
        }
      : {
          name: node.name,
          type: node.type,
          kind: node.kind,
          read: () => node.read(),
          lastUpdatedMs: () => node.lastUpdatedMs(),
        };
  }

  names(): string[] {
    return [...(this.parent?.names() ?? []), ...this.nodes.keys()];
  }

  // Release every computed's subscriptions, so nothing outliving this store
  // (the daemon-wide SessionState atom) keeps it reachable. The store's own
  // boxes and documents die with it; only the computeds hold references
  // outward. Reads after dispose still answer — a released computed recomputes
  // uncached, and outside a batch subscribes to nothing (inside one, MobX
  // tracks it for the batch and unobserves again as the batch ends) — so a
  // late reader cannot resubscribe the store to the world for good. A
  // declaration after dispose would: it would mint a keepAlive computed with
  // no release to come, so `declare` and `derive` refuse it. Returns how many computeds it
  // released, the fact the caller's log line carries (0 on a second call). One action, so the
  // cascading unobservation settles once, when it ends. [LAW:single-enforcer]
  // called by SourceRegistry.dispose, the one teardown of everything a config
  // holds.
  dispose(): number {
    // Idempotent: a second call released nothing, and says so, rather than
    // reporting the same computeds twice.
    if (this.disposed) return 0;
    this.disposed = true;
    let released = 0;
    mobxRunInAction(() => {
      for (const node of this.nodes.values()) {
        if (node instanceof ComputedNode) {
          node.release();
          released++;
        }
      }
      for (const kept of this.kept) kept.release();
    });
    return released + this.kept.length;
  }

  private disposed = false;

  private requireNode(name: string): StoreNode {
    const node = this.nodes.get(name) ?? this.parent?.requireNode(name);
    if (!node) throw new ReferenceError(`Unknown variable "${name}"`);
    return node;
  }

  // [LAW:single-enforcer] The one door a write takes: a node of this store.
  // A view writing its directory's node would write every session's value.
  private requireOwn(name: string): StoreNode {
    const node = this.nodes.get(name);
    if (node !== undefined) return node;
    if (this.parent?.has(name)) {
      throw new Error(
        `Variable "${name}" lives in the directory's store; a session's view cannot write it`,
      );
    }
    throw new ReferenceError(`Unknown variable "${name}"`);
  }

  // [LAW:parse-dont-validate] The scalar reads (`read`, `getType`) demand a
  // VarNode; a document reached through them is a caller asking a namespace
  // for a scalar, said so by name rather than coerced to text.
  private requireVar(name: string): VarNode {
    const node = this.requireNode(name);
    if (node.kind === "document") {
      throw new TypeError(
        `Variable "${name}" is a document; read its fields by path (.${name}.<field>)`,
      );
    }
    return node;
  }

  // [LAW:no-silent-failure] A computed declared after dispose has no release
  // to come: it would subscribe to the world and hold this store exactly as
  // before brandon-unfiled-3248.t14.
  private refuseDisposed(what: string): void {
    if (this.disposed) {
      throw new Error(`${what}: cannot declare on a disposed store`);
    }
  }

  private declare(name: string, node: StoreNode): void {
    this.refuseDisposed(`Variable "${name}"`);
    if (this.has(name)) {
      throw new Error(`Variable "${name}" is already declared`);
    }
    mobxRunInAction(() => this.nodes.set(name, node));
  }
}
