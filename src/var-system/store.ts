// [LAW:one-source-of-truth] THE place every variable's value lives; no parallel cache.
// MobX builds the invalidation graph from what a computed's deriver reads.

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
  // [LAW:types-are-the-program] Age belongs to the node; null for computeds, whose freshness is MobX invalidation.
  lastUpdatedMs(): number | null;
}

class BoxNode implements VarNode {
  readonly kind = "box" as const;
  private readonly cell: IObservableValue<VarValue>;
  // [LAW:single-enforcer] One write path updates value and timestamp together.
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
    // [LAW:one-source-of-truth] The render path is pull-only, so keepAlive is the only mode that caches.
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
    // [LAW:no-defensive-null-guards] null is structurally distinct from "updated at 0".
    return null;
  }
}

// [LAW:types-are-the-program] It holds an Outcome so "not scanned" and "scan failed" travel
// WITH the value. [LAW:single-enforcer] toDocument shapes every ok value on the way in.
export interface DocumentNode {
  readonly name: string;
  readonly kind: "document";
  read(): Outcome<JsonValue>;
  lastUpdatedMs(): number;
}

class DocumentCell implements DocumentNode {
  readonly kind = "document" as const;
  private readonly cell: IObservableValue<Outcome<JsonValue>>;
  private lastSetAt: number;

  constructor(
    readonly name: string,
    initial: Outcome<JsonValue>,
  ) {
    this.cell = observable.box(shaped(initial), { deep: false });
    this.lastSetAt = Date.now();
  }

  read(): Outcome<JsonValue> {
    return this.cell.get();
  }

  set(value: Outcome<JsonValue>): void {
    this.cell.set(shaped(value));
    this.lastSetAt = Date.now();
  }

  lastUpdatedMs(): number {
    return this.lastSetAt;
  }
}

function shaped(outcome: Outcome<JsonValue>): Outcome<JsonValue> {
  return outcome.kind === "ok"
    ? { kind: "ok", value: toDocument(outcome.value) }
    : outcome;
}

// [LAW:one-type-per-behavior] `read`'s result type is the discriminator's payload.
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

// [LAW:single-enforcer] One store per daemon: two would split the dep graph.

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

  // Calling `read(other)` inside the deriver is what registers the dependency with MobX.
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
    // [LAW:single-enforcer] All mutations go through one action, so callers need not remember.
    mobxRunInAction(() => (node as BoxNode).set(value));
  }

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

  // [LAW:one-source-of-truth] The ONE spelling a change-driven reaction compares, over both kinds.
  changeKey(name: string): string {
    const node = this.requireNode(name);
    return node.kind === "document"
      ? JSON.stringify(node.read())
      : String(node.read());
  }

  // [LAW:types-are-the-program] Returning the node directly would leak `.set` [LAW:single-enforcer].
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

  // [LAW:parse-dont-validate] A document reached through a scalar read is refused by name, never coerced.
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
