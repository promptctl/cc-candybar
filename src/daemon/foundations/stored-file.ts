// What a stored file's load says of what it could not use, shared by the
// host's stores, their parsers and the repository gate.
import type { Asked } from "../../utils/outcome.js";

// [LAW:one-source-of-truth] How every stored file that did not read is said:
// what could not be read and why, then where its bytes are now and what that
// means.
export const unreadText = (reason: string, where: string): string =>
  `could not be read: ${reason} — ${where}`;

// [LAW:types-are-the-program] A read that failed names the location that did
// not read, so a write planned from it knows what to set aside. Its reason
// starts with that location, as the reader's and the parse's reasons do.
export interface Unread {
  readonly kind: "failed";
  readonly reason: string;
  readonly file: string;
}

// [LAW:single-enforcer] What a stored file that did not read holds for every
// reader and every write planned from it: its store's empty value. Nothing
// it held is trusted, and its bytes are set aside before any write.
export const readOrEmpty = <T>(
  result:
    | { readonly kind: "ok"; readonly value: T }
    | { readonly kind: "failed" },
  empty: T,
): T => (result.kind === "ok" ? result.value : empty);

// An unread file as it was set aside: the name it was read under and why it
// did not read, and the file its bytes sat in (a link's target) and where
// they are now.
export interface SetAside {
  readonly file: string;
  readonly reason: string;
  readonly from: string;
  readonly to: string;
}

// [LAW:types-are-the-program] What a load gave up of one session, and why
// this build refuses it: the session whole, or a part of its value.
export interface DroppedPart {
  // The part, or null for the session whole.
  readonly part: string | null;
  readonly why: string;
}

export interface Dropped extends DroppedPart {
  readonly session: string;
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

// [LAW:types-are-the-program] What a store found of its file: none, a file
// that read (and what of it this build dropped), or one that did not, set
// aside under `to`, or left where it is because setting it aside failed.
export type Found =
  | { readonly kind: "absent" }
  | {
      readonly kind: "read";
      readonly sessions: number;
      readonly dropped: readonly Dropped[];
    }
  | { readonly kind: "set-aside"; readonly reason: string; readonly to: string }
  | {
      readonly kind: "refused";
      readonly reason: string;
      readonly error: string;
    };

// [LAW:one-type-per-behavior] One report for every store that keeps a file:
// the per-session stores at their load, the repository answers when a write
// sets their book aside.
export interface StoreReport {
  // The store, as the bar names it.
  readonly store: string;
  readonly file: string;
  readonly found: Found;
}

// [LAW:no-silent-failure] A per-session file that did not read and could not
// be set aside: nothing is saved to it while this daemon runs, so it stands
// on every bar for as long, about its file.
export interface StoreUnsavedWarning {
  readonly kind: "store-unsaved";
  readonly file: string;
  readonly message: string;
}

// [LAW:one-source-of-truth] What the bar says of a store's file, or null for
// one with nothing to say: a file kept aside, one nothing is saved to, and
// what a load dropped, grouped by what and why so a renamed key dropped from
// every session is one line. An unread reason already names its file.
export function reportText({ store, file, found }: StoreReport): string | null {
  switch (found.kind) {
    case "absent":
      return null;
    case "set-aside":
    case "refused":
      return unreadReport(store, found);
    case "read":
      return found.dropped.length === 0
        ? null
        : `${store} (${file}): the load dropped what this build does not read: ${droppedText(found.dropped, SHOWN_SESSIONS)}`;
  }
}

// [LAW:nothing-unseen] The log's line for every report, so a store that
// found nothing is told apart from one that never looked. The bar's event
// leaves, so the log is what keeps every dropped session's name.
export function reportLine(report: StoreReport): string {
  const { store, file, found } = report;
  switch (found.kind) {
    case "absent":
      return `${store}: no file at ${file}, holding nothing`;
    case "read":
      return `${store}: read ${file}, sessions=${found.sessions} dropped=${found.dropped.length}${found.dropped.length === 0 ? "" : `: ${droppedText(found.dropped, Infinity)}`}`;
    case "set-aside":
    case "refused":
      return unreadReport(store, found);
  }
}

function unreadReport(
  store: string,
  found: Extract<Found, { kind: "set-aside" | "refused" }>,
): string {
  const where =
    found.kind === "set-aside"
      ? `it is kept as ${found.to}, and the store started again from empty`
      : `it stays where it is, since setting it aside failed (${found.error}), and nothing is saved to it until the daemon starts again`;
  return `${store} ${unreadText(found.reason, where)}`;
}

const SHOWN_SESSIONS = 3;

// The sessions named per group: the bar's line names a few, the log all.
function droppedText(dropped: readonly Dropped[], shown: number): string {
  const groups = new Map<string, string[]>();
  for (const { session, part, why } of dropped) {
    const what = part === null ? `a session (${why})` : `${part} (${why})`;
    const sessions = groups.get(what);
    if (sessions === undefined) groups.set(what, [session]);
    else sessions.push(session);
  }
  return [...groups]
    .map(([what, sessions]) => {
      const named = sessions.slice(0, shown).map((s) => JSON.stringify(s));
      const more = sessions.length - named.length;
      return `${what} in ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
    })
    .join("; ");
}
