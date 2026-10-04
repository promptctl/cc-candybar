export const setTimeout = <T>(ms: number, value?: T): Promise<T | undefined> =>
  new Promise((r) => globalThis.setTimeout(() => r(value), ms));
export default { setTimeout };
