// [LAW:single-enforcer] How a click's config writes leave the renderer: as
// `change`s its turn returns, which the host performs, never as a file the
// renderer writes. A repository answer lands the same way, as `approve-repo`,
// since it changes which layers a config is made of. A click lands whole or
// not at all, so what else it did is its consequence (its journal's commit),
// held here from its turn until its writes' `effect-done`s: applied once they
// land, in the turn of the last, dropped when they do not. A journal turn opens only once no click's changes are on their way
// (src/renderer/journal-turns.ts), so each click reads the files the clicks
// ahead of it wrote, and at most one click is ever landing. The host owes every
// change it is handed its `effect-done` (src/daemon/renderer-host.ts).

import { diffChanges } from "../config/config-changes.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import type {
  Act,
  ConfigChange,
  Effect,
  EffectId,
  EffectOutcome,
} from "../renderer-interface/interface.js";
import type { RepoAnswer } from "../config/loader/repo-gate.js";

// A click whose writes are on their way: the session it clicked, the files
// they change, whether it answered a repository, and its consequence, applied
// with the effects of the turn it lands in.
export interface Landing {
  readonly session: SessionId;
  readonly files: readonly string[];
  readonly answered: boolean;
  readonly consequence: (effects: Effect[]) => void;
}

// How a landing ended: every change of its click landed, or the first reason
// one did not.
export type Landed = Landing & { readonly outcome: EffectOutcome };

export class ConfigWrites {
  // The open click's writes, by file: what it read first, and wrote last.
  private readonly open = new Map<
    string,
    { readonly before: string | null; readonly after: string | null }
  >();
  // The open click's repository answers, in the order it gave them.
  private answers: Array<{
    readonly dir: string;
    readonly answer: RepoAnswer;
  }> = [];
  private landing: {
    readonly of: Landing;
    readonly owed: Set<EffectId>;
    missed: Exclude<EffectOutcome, { kind: "ok" }> | null;
  } | null = null;
  private waiting: Array<() => void> = [];
  private closed = false;

  constructor(
    private readonly mint: () => EffectId,
    // The file as it stands on disk.
    private readonly disk: (file: string) => string | null,
  ) {}

  // [LAW:one-source-of-truth] `file` as the open click left it: its last
  // write, else the disk, which holds every click ahead of it.
  read(file: string): string | null {
    const written = this.open.get(file);
    return written === undefined ? this.disk(file) : written.after;
  }

  // A write of the open click, from the file as the click read it (`read`):
  // one change per file, from the click's first read of it to its last write.
  land(file: string, before: string | null, after: string | null): void {
    const open = this.open.get(file);
    // An absent file read first stays absent: its `before` is null.
    this.open.set(file, {
      before: open === undefined ? before : open.before,
      after,
    });
  }

  // A repository answer of the open click.
  answer(dir: string, answer: RepoAnswer): void {
    this.answers.push({ dir, answer });
  }

  // The open click is over. Its changes join its turn's effects, and its
  // consequence waits for them; a click that changed no file has its
  // consequence now.
  seal(
    effects: Effect[],
    session: SessionId | null,
    consequence: (effects: Effect[]) => void,
  ): void {
    const answers = this.answers.splice(0);
    // [LAW:no-ambient-temporal-coupling] A click the daemon's close cut off
    // lands nothing, so nothing of it is performed under the teardown.
    if (this.closed) return this.open.clear();
    const written = [...this.open].flatMap(([path, { before, after }]) => {
      const list = diffChanges(before, after);
      return list.length === 0 ? [] : [{ path, list }];
    });
    const files = written.map(({ path }) => path);
    this.open.clear();
    if (written.length === 0 && answers.length === 0)
      return consequence(effects);
    // [LAW:no-silent-failure] A write is a session's: one with none is the
    // click's bug.
    if (session === null)
      throw new Error(
        `a click with no session wrote ${[...files, ...answers.map(({ dir }) => dir)].join(", ")}`,
      );
    const changes = written.map(
      ({ path, list }): ConfigChange => ({
        kind: "change",
        id: this.mint(),
        session,
        target: { kind: "layer", path },
        changes: list,
      }),
    );
    const approvals = answers.map(
      ({ dir, answer }): Act => ({
        kind: "approve-repo",
        id: this.mint(),
        session,
        dir,
        answer,
      }),
    );
    this.landing = {
      of: { session, files, answered: approvals.length > 0, consequence },
      owed: new Set([...changes, ...approvals].map((e) => e.id)),
      missed: null,
    };
    effects.push(...changes, ...approvals);
  }

  // A write's `effect-done`: the landing once its last write is settled,
  // `owed` while others are still on their way, or undefined for an id no
  // write of this renderer's holds.
  settled(id: EffectId, outcome: EffectOutcome): Landed | "owed" | undefined {
    const landing = this.landing;
    if (landing === null || !landing.owed.delete(id)) return undefined;
    if (outcome.kind !== "ok") landing.missed ??= outcome;
    if (landing.owed.size > 0) return "owed";
    this.landing = null;
    for (const resume of this.waiting.splice(0)) resume();
    return { ...landing.of, outcome: landing.missed ?? { kind: "ok" } };
  }

  // No click seals after this: the daemon is closing.
  close(): void {
    this.closed = true;
  }

  // Resolves once no click's changes are on their way.
  landed(): Promise<void> {
    return this.landing === null
      ? Promise.resolve()
      : new Promise((resume) => this.waiting.push(resume));
  }
}
