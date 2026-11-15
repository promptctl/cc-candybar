// The bar's warning while file events may have gone unheard, from the
// delivery state the host reports.

import type { Delivery } from "./stats-snapshot";

export const iso = (at: number): string => new Date(at).toISOString();

export const stopped = (since: number): string =>
  `file events stopped at ${iso(since)}; the OS has delivered none since, not even for a file the daemon wrote to test it`;

// [LAW:no-silent-failure] The bar's row for as long as the span is open,
// whatever state delivery is in: an edit made after the span's start may never
// have been heard, and only an event the watch reports closes it. With no span
// open nothing can have gone unheard, so a delivering watch draws none, and
// neither does an owner never started: the page's simulated machine watches
// nothing an edit could depend on, and a test's daemon in a jest worker proves
// the watches it reads by a delivered event.
export interface FileEventsWarning {
  readonly kind: "file-events";
  readonly state: Delivery["kind"];
  readonly message: string;
}

// [LAW:one-source-of-truth] The row states the watch rule, not a consumer: a
// file watched by name is read by path and rides no file event, and what is
// watched whole or as a tree rides them (`polled`). Which consumer watches
// which shape is each consumer's own.
export function fileEventsWarnings(d: Delivery): FileEventsWarning[] {
  if (d.missedSince === null) return [];
  const since = iso(d.missedSince);
  const message = (): string => {
    switch (d.kind) {
      case "delivering":
        return `file events unconfirmed since ${since}: the probe written to test them has not been heard yet, so a change made since in a folder watched whole may not have been seen; a file watched by name still is`;
      case "stalled":
        return `${stopped(d.missedSince)}, so a folder watched whole won't refresh until they resume; a file watched by name still does`;
      case "unmeasured":
        return `since ${since}, the daemon cannot check whether file events are arriving: ${d.reason}`;
    }
  };
  return [{ kind: "file-events", state: d.kind, message: message() }];
}
