// [LAW:single-enforcer] How a click's config writes reach the host. A write is
// a `change` effect, which only a turn's output carries, and the click must
// hear how it landed before it goes on (a reload reads the file it wrote). So
// a click runs across turns: its own turn answers with its first change, the
// `effect-done` of each change answers with the next one, and the turn after
// the click's last change answers with none once the click ends. The host
// performs a change from whatever turn returns it, so the chain needs nothing
// of it but that.

import type { SessionId } from "../daemon/foundations/session-id.js";
import type { Change } from "../config/config-changes.js";
import type {
  ConfigChange,
  EffectId,
  EffectOutcome,
} from "../renderer-interface/interface.js";

// Lands `changes` to the session's user layer, and says how they landed.
export type Land = (
  session: SessionId,
  changes: readonly Change[],
) => Promise<EffectOutcome>;

interface Stretch {
  readonly answer: Promise<readonly ConfigChange[]>;
  readonly end: (changes: readonly ConfigChange[]) => void;
  readonly fail: (thrown: unknown) => void;
}

function stretch(): Stretch {
  let end!: Stretch["end"];
  let fail!: Stretch["fail"];
  const answer = new Promise<readonly ConfigChange[]>((resolve, reject) => {
    end = resolve;
    fail = reject;
  });
  return { answer, end, fail };
}

export class Landings {
  // Each change on its way, by its id: what its `effect-done` settles, and
  // the stretch of the click that turn answers with.
  private readonly awaiting = new Map<
    EffectId,
    (outcome: EffectOutcome) => Promise<readonly ConfigChange[]>
  >();

  constructor(private readonly mint: () => EffectId) {}

  // Runs a click, answering with what its turn returns: its first change, or
  // none once it ended without one. A click that threw before its first
  // change throws here.
  run(click: (land: Land) => Promise<void>): Promise<readonly ConfigChange[]> {
    let current = stretch();
    const first = current.answer;
    const land: Land = (session, changes) => {
      const id = this.mint();
      const ended = current;
      current = stretch();
      const outcome = new Promise<EffectOutcome>((settle) =>
        this.awaiting.set(id, (done) => {
          settle(done);
          return current.answer;
        }),
      );
      ended.end([
        {
          kind: "change",
          id,
          session,
          target: { kind: "layer", role: "user" },
          changes,
        },
      ]);
      return outcome;
    };
    void click(land).then(
      () => current.end([]),
      (thrown: unknown) => current.fail(thrown),
    );
    return first;
  }

  // The `effect-done` of a change: the click hears its outcome, and the turn
  // answers with the click's next stretch. Undefined for an id no click is
  // waiting on.
  done(
    id: EffectId,
    outcome: EffectOutcome,
  ): Promise<readonly ConfigChange[]> | undefined {
    const settle = this.awaiting.get(id);
    if (settle === undefined) return undefined;
    this.awaiting.delete(id);
    return settle(outcome);
  }
}
