import { observable, type IObservableValue } from "mobx";
import type { Fact } from "../facts/fact";
import { pendingOf } from "../utils/outcome";
import type { Update } from "./update-notice";

// [LAW:one-source-of-truth] The update as a fact, stamped once by the watch
// that owns it (src/daemon/update-notice.ts) and read by every session's
// document: one change has one instant for every session. A caller with no
// watch holds a box nothing writes, pending as a watch not yet sampled. Its own
// module, so the demo's composition holds one without loading the watch.
export type UpdateFact = IObservableValue<Fact<Update>>;

export function newUpdateFact(): UpdateFact {
  return observable.box<Fact<Update>>(pendingOf("unread"), { deep: false });
}
