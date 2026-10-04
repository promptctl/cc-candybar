// Node's timers return a Timeout object (unref/ref/hasRef/refresh); the page's return a number.
// These wrap the page's own, so a daemon that unrefs its sweeps runs unchanged.
// The page's own timers, typed as the page has them (this file is checked against Node's types).
interface PageTimers {
  setTimeout(fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]): number;
  setInterval(fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]): number;
  clearTimeout(id?: number): void;
  clearInterval(id?: number): void;
}
const page = globalThis as unknown as PageTimers;
const native: PageTimers = {
  setTimeout: page.setTimeout.bind(globalThis),
  setInterval: page.setInterval.bind(globalThis),
  clearTimeout: page.clearTimeout.bind(globalThis),
  clearInterval: page.clearInterval.bind(globalThis),
};

class Timeout {
  constructor(
    public id: number,
    private readonly restart: () => number,
  ) {}
  unref() { return this; }
  ref() { return this; }
  hasRef() { return true; }
  refresh() { native.clearTimeout(this.id); this.id = this.restart(); return this; }
  [Symbol.toPrimitive]() { return this.id; }
}

type Fn = (...a: unknown[]) => void;
const idOf = (t: unknown): number | undefined => (t instanceof Timeout ? t.id : (t as number | undefined));

const setTimeout = (fn: Fn, ms?: number, ...a: unknown[]): Timeout => {
  const start = () => native.setTimeout(fn, ms, ...a);
  return new Timeout(start(), start);
};
const setInterval = (fn: Fn, ms?: number, ...a: unknown[]): Timeout => {
  const start = () => native.setInterval(fn, ms, ...a);
  return new Timeout(start(), start);
};
const clearTimeout = (t: unknown): void => native.clearTimeout(idOf(t));
const clearInterval = (t: unknown): void => native.clearInterval(idOf(t));
const setImmediate = (fn: Fn, ...a: unknown[]): Timeout => setTimeout(fn, 0, ...a);
const clearImmediate = clearTimeout;

export { setTimeout, setInterval, clearTimeout, clearInterval, setImmediate, clearImmediate };
export default { setTimeout, setInterval, clearTimeout, clearInterval, setImmediate, clearImmediate };
