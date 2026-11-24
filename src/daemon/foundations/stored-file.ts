// What a stored file's load says of what it could not use, shared by the
// host's stores, their parsers and the repository gate.
import type { Asked } from "../../utils/outcome.js";

// [LAW:one-source-of-truth] How every stored file that did not read is said:
// what could not be read and why, then where its bytes are now and what that
// means.
export const unreadText = (reason: string, where: string): string =>
  `could not be read: ${reason} — ${where}`;

// [LAW:types-are-the-program] What a load gave up of one session, and why
// this build refuses it: the session whole, or a part of its value.
export interface DroppedPart {
  // The part, or null for the session whole.
  readonly part: string | null;
  readonly why: string;
}

// A session's value as a load keeps it, and what of it the load gave up.
export interface Kept<V> {
  readonly value: V;
  readonly dropped: readonly DroppedPart[];
}

export const kept = <V>(
  value: V,
  dropped: readonly DroppedPart[] = [],
): Asked<Kept<V>> => ({ kind: "ok", value: { value, dropped } });

// [LAW:no-silent-failure] A per-session file that did not read and could not
// be set aside: nothing is saved to it while this daemon runs, so it stands
// on every bar for as long, about its file.
export interface StoreUnsavedWarning {
  readonly kind: "store-unsaved";
  readonly file: string;
  readonly message: string;
}

// The newest entry of a map whose insertion order is recency.
export function newestOf<K>(map: ReadonlyMap<K, unknown>): K | undefined {
  let newest: K | undefined;
  for (const key of map.keys()) newest = key;
  return newest;
}
