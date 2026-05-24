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
import { typeOf, type VarType, type VarValue } from "./types";

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
  private lastSetAt: number;

  constructor(
    readonly name: string,
    readonly type: VarType,
    initial: VarValue,
  ) {
    assertType(name, type, initial, "initial value");
    this.cell = observable.box(initial, { deep: false });
    this.lastSetAt = Date.now();
  }

  read(): VarValue {
    return this.cell.get();
  }

  set(value: VarValue): void {
    assertType(this.name, this.type, value, "set value");
    this.cell.set(value);
    this.lastSetAt = Date.now();
  }

  lastUpdatedMs(): number {
    return this.lastSetAt;
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
  private readonly nodes = new Map<string, VarNode>();

  defineBox(name: string, type: VarType, initial: VarValue): void {
    this.assertNotDefined(name);
    this.nodes.set(name, new BoxNode(name, type, initial));
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
    return this.requireNode(name).read();
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
    return this.requireNode(name).type;
  }

  getKind(name: string): "box" | "computed" {
    return this.requireNode(name).kind;
  }

  // [LAW:locality-or-seam] Introspection (src/daemon/debug.ts) needs the
  // whole node — type, kind, lastUpdatedMs — without bouncing through three
  // accessor methods that each repeat the requireNode lookup. The returned
  // VarNode is read-only by interface (no set/define), so exposing it
  // does not widen the mutation surface.
  getNode(name: string): VarNode {
    return this.requireNode(name);
  }

  names(): string[] {
    return [...this.nodes.keys()];
  }

  private requireNode(name: string): VarNode {
    const node = this.nodes.get(name);
    if (!node) throw new ReferenceError(`Unknown variable "${name}"`);
    return node;
  }

  private assertNotDefined(name: string): void {
    if (this.nodes.has(name)) {
      throw new Error(`Variable "${name}" is already declared`);
    }
  }
}
