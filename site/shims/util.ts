import { parseArgs } from "@pkgjs/parseargs";
export { parseArgs };
export const types = { isNativeError: (e: unknown): e is Error => e instanceof Error };
export const inspect = (v: unknown): string => { try { return JSON.stringify(v); } catch { return String(v); } };
export const format = (...a: unknown[]): string => a.map(String).join(" ");
export const promisify = <T extends (...a: never[]) => unknown>(f: T) => f;
export default { parseArgs, types, inspect, format, promisify };
