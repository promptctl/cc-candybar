// The host's hold of each open view's runs, for a test that drives a render
// cache with no collector: `hold` holds a view's runs over one owner, as a
// session's declaration does, and the source answers each session's runs from
// its holder, as its world state would carry them. Every other input of the
// view is not answered yet (`SOURCES_NOTHING`).

import { observable, runInAction } from "mobx";
import { CheckRuns } from "../../src/check-runs";
import {
  SOURCES_NOTHING,
  type SessionView,
  type SourceOf,
} from "../../src/renderer/render-cache";
import type { SessionId } from "../../src/daemon/foundations/session-id";
import { SourceRuns } from "../../src/daemon/source-runs";
import type { ViewSource } from "../../src/dsl/view-source";
import { UNREAD_RUN } from "../../src/facts/world-state";
import type { Launcher } from "../../src/proc/launcher";
import { systemTimekeeper } from "../../src/time";
import { instantOf } from "../../src/utils/instant";
import { pendingOf } from "../../src/utils/outcome";
import { TEST_ENV } from "./session-environment";

export interface HeldRuns {
  readonly source: SourceOf<ViewSource>;
  // The session's runs, held from its view's registry from now on.
  hold(view: SessionView): void;
}

export function heldRuns(
  launcher: Launcher,
  cleanups: Array<() => void>,
): HeldRuns {
  const sourceRuns = new SourceRuns({ launcher, clock: systemTimekeeper });
  const holders = observable.map<SessionId, CheckRuns>(undefined, {
    deep: false,
  });
  cleanups.push(() => {
    for (const held of holders.values()) held.close();
    sourceRuns.close();
  });
  return {
    source: (view) => ({
      ...SOURCES_NOTHING(view),
      run: (digest) => holders.get(view.sessionId)?.run(digest) ?? UNREAD_RUN,
      env: (name) =>
        holders.get(view.sessionId)?.env(name) ?? pendingOf("unread"),
    }),
    hold: (view) => {
      const held = new CheckRuns(
        sourceRuns,
        view.registry,
        instantOf(new Date()),
        TEST_ENV,
      );
      const prior = holders.get(view.sessionId);
      runInAction(() => holders.set(view.sessionId, held));
      prior?.close();
    },
  };
}
