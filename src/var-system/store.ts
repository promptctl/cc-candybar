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

export interface VarNode {
  readonly name: string;
  readonly type: VarType;
  readonly kind: "box" | "computed";
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

class ComputedNode implements VarNode {
  readonly kind = "computed" as const;
  private readonly cell: IComputedValue<VarValue>;

  constructor(
    readonly name: string,
    readonly type: VarType,
    deriver: () => VarValue,
  ) {
    // [LAW:one-source-of-truth] keepAlive caches the value across reads
    // so `.get()` re-runs the deriver only when a tracked dep
    // invalidates — without it, MobX treats an unobserved computed as
    // "not cached" and re-runs on every read. The render path is pull-
    // only (no autorun), so keepAlive is the only mode that gives the
    // reactive-cache contract the proposal promises.
    this.cell = computed(
      () => {
        const v = deriver();
        assertType(this.name, this.type, v, "computed result");
        return v;
      },
      { keepAlive: true },
    );
  }

  read(): VarValue {
    return this.cell.get();
  }

  lastUpdatedMs(): null {
    // [LAW:no-defensive-null-guards] Computed nodes have no single
    // "updated" moment — the cache is valid until a tracked dep changes.
    // Returning null is structurally distinct from "updated at 0," so a
    // consumer can render "—" for computed and a real age for boxes.
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

// [LAW:single-enforcer] All declarations and reads go through one
// VariableStore instance per daemon. Two stores cannot coexist for the
// same daemon — the dep graph would split, click handlers would mutate
// one while renders read the other.

export class VariableStore {
  private readonly nodes = new Map<string, StoreNode>();

  defineBox(name: string, type: VarType, initial: VarValue): void {
    this.assertNotDefined(name);
    this.nodes.set(name, new BoxNode(name, type, initial));
  }

  defineDocument(name: string, initial: Outcome<JsonValue>): void {
    this.assertNotDefined(name);
    this.nodes.set(name, new DocumentCell(name, initial));
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
    this.assertNotDefined(name);
    const reader = (other: string): VarValue => this.read(other);
    this.nodes.set(name, new ComputedNode(name, type, () => deriver(reader)));
  }

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
    const node = this.requireNode(name);
    if (node.kind !== "document") {
      throw new TypeError(
        `Variable "${name}" is a ${node.kind}, not a document (use defineDocument to create one)`,
      );
    }
    mobxRunInAction(() => (node as DocumentCell).set(value));
  }

  setBox(name: string, value: VarValue): void {
    const node = this.requireNode(name);
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
    return this.nodes.has(name);
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
    return [...this.nodes.keys()];
  }

  private requireNode(name: string): StoreNode {
    const node = this.nodes.get(name);
    if (!node) throw new ReferenceError(`Unknown variable "${name}"`);
    return node;
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

  private assertNotDefined(name: string): void {
    if (this.nodes.has(name)) {
      throw new Error(`Variable "${name}" is already declared`);
    }
  }
}
