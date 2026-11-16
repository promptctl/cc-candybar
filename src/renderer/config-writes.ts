// [LAW:single-enforcer] How a click's config writes leave the renderer: as
// `change`s its turn returns, which the host performs, never as a file the
// renderer writes. A click lands whole or not at all, so what else it did is
// its consequence (its journal's commit), held here from its turn until its
// changes' `effect-done`s: applied once they land, dropped when they do not,
// and the history's answer to the refusal run when a setting moved under
// them. A journal turn opens only once no click's changes are on their way
// (src/renderer/journal-turns.ts), so each click reads the files the clicks
// ahead of it wrote, and at most one click is ever landing. The host owes every
// change it is handed its `effect-done` (src/daemon/renderer-host.ts).

import {
  addressText,
  applyChanges,
  diffChanges,
} from "../config/config-changes.js";
import { BadVerbArgs } from "../daemon/foundations/verb-error.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import type {
  ConfigChange,
  Effect,
  EffectId,
  EffectOutcome,
} from "../renderer-interface/interface.js";

// A click whose changes are on their way: the session it clicked, the files
// they change, its consequence, and what a refusal of them leaves behind.
export interface Landing {
  readonly session: SessionId;
  readonly files: readonly string[];
  readonly consequence: () => void;
  readonly refused: () => void;
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
  private landing: {
    readonly of: Landing;
    readonly owed: Set<EffectId>;
    missed: Exclude<EffectOutcome, { kind: "ok" }> | null;
  } | null = null;
  private waiting: Array<() => void> = [];

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

  // A write of the open click: one change per file, from the click's first
  // read of it to its last write. A write from text other than the click's
  // own (a history step, from what it recorded) lands as the changes between
  // its two texts, applied over what the click already wrote.
  land(file: string, before: string | null, after: string | null): void {
    const open = this.open.get(file);
    if (open === undefined) {
      this.open.set(file, { before, after });
      return;
    }
    const applied = applyChanges(open.after, diffChanges(before, after));
    // [LAW:no-silent-failure] The click's own writes moved a setting its
    // later write steps from: the click contradicts itself.
    if (applied.kind === "moved")
      throw new BadVerbArgs(
        `${addressText(applied.at)} in ${file} was changed earlier in this click — nothing was written`,
      );
    this.open.set(file, { before: open.before, after: applied.text });
  }

  // The open click is over. Its changes join its turn's effects, and its
  // consequence waits for them; a click that changed no file has its
  // consequence now.
  seal(
    effects: Effect[],
    session: SessionId | null,
    { consequence, refused }: Pick<Landing, "consequence" | "refused">,
  ): void {
    const written = [...this.open].flatMap(([path, { before, after }]) => {
      const list = diffChanges(before, after);
      return list.length === 0 ? [] : [{ path, list }];
    });
    const files = written.map(({ path }) => path);
    this.open.clear();
    if (written.length === 0) return consequence();
    // [LAW:no-silent-failure] A write is a session's: one with none is the
    // click's bug.
    if (session === null)
      throw new Error(`a click with no session wrote ${files.join(", ")}`);
    const changes = written.map(
      ({ path, list }): ConfigChange => ({
        kind: "change",
        id: this.mint(),
        session,
        target: { kind: "layer", path },
        changes: list,
      }),
    );
    this.landing = {
      of: { session, files, consequence, refused },
      owed: new Set(changes.map((c) => c.id)),
      missed: null,
    };
    effects.push(...changes);
  }

  // A change's `effect-done`: the landing once its last change is settled,
  // `owed` while others are still on their way, or undefined for an id no
  // change of this renderer's holds.
  settled(id: EffectId, outcome: EffectOutcome): Landed | "owed" | undefined {
    const landing = this.landing;
    if (landing === null || !landing.owed.delete(id)) return undefined;
    if (outcome.kind !== "ok") landing.missed ??= outcome;
    if (landing.owed.size > 0) return "owed";
    this.landing = null;
    for (const resume of this.waiting.splice(0)) resume();
    return { ...landing.of, outcome: landing.missed ?? { kind: "ok" } };
  }

  // Resolves once no click's changes are on their way.
  landed(): Promise<void> {
    return this.landing === null
      ? Promise.resolve()
      : new Promise((resume) => this.waiting.push(resume));
  }
}
