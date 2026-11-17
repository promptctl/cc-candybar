// [LAW:single-enforcer] How a click's config writes leave the renderer: as
// `change`s its turn returns, which the host performs, never as a file the
// renderer writes, and with them its answers to the trust book, which decide
// which config a session renders. A click lands whole or not at all, so what
// else it did is its consequence (its journal's commit), held here from its
// turn until its changes' `effect-done`s: applied once they land, dropped
// when they do not. The host lands a turn's changes, and hands in their
// `effect-done`s, before the renderer's next input (src/daemon/renderer-host.ts),
// with the config turns of the sessions they moved, so each click reads the
// layers the clicks ahead of it wrote, and at most one click is ever landing.

import { diffChanges, type Change } from "../config/config-changes.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import {
  BadVerbArgs,
  DaemonClosing,
} from "../daemon/foundations/verb-error.js";
import type { Layer } from "../config/config-snapshot.js";
import type { RepoAnswer } from "../config/loader/repo-gate.js";
import type {
  Act,
  ConfigChange,
  Effect,
  EffectId,
  EffectOutcome,
} from "../renderer-interface/interface.js";

// What a click's consequence is applied in: the turn its changes landed in,
// whose effects what it asks joins.
export type Consequence = (effects: Effect[]) => void;

// A click whose changes are on their way: the session it clicked, the files
// they change, whether it answered the trust book, and its consequence.
export interface Landing {
  readonly session: SessionId;
  readonly files: readonly string[];
  readonly answered: boolean;
  readonly consequence: Consequence;
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
  private closed = false;
  // The chain of the open click's session, as its newest config turn handed
  // it in: what a layer it reads holds before the click writes it. Null for a
  // click with no session, or one whose session's config has not arrived.
  private chain: readonly Layer[] | null = null;
  // The open click's changes to Claude Code's settings, which no renderer
  // reads: each made against what the session's doctor reading saw.
  private settings: Array<{ readonly file: string; readonly change: Change }> =
    [];
  // The open click's answers to the trust book, in the order it gave them.
  private answers: Array<{
    readonly dir: string;
    readonly answer: RepoAnswer;
  }> = [];

  constructor(private readonly mint: () => EffectId) {}

  // A click's journal opens over its session's chain: refused once the
  // daemon's close has begun, so a click the close cut off writes nothing.
  // [LAW:no-silent-failure] A landing still owed here is the host's bug: it
  // hands a turn's `effect-done`s in before the next input.
  begin(verb: string, chain: readonly Layer[] | null): void {
    if (this.closed) throw new DaemonClosing(verb);
    if (this.landing !== null)
      throw new Error(
        `${verb} began while a click's changes to ${this.landing.of.files.join(", ")} were still landing`,
      );
    this.chain = chain;
  }

  // [LAW:one-source-of-truth] `file` as the open click left it: its last
  // write, else the layer as its session's chain holds it, which holds every
  // click ahead of it.
  read(file: string): string | null {
    const written = this.open.get(file);
    if (written !== undefined) return written.after;
    const { content } = this.layerAt(file);
    switch (content.kind) {
      case "text":
        return content.text;
      case "absent":
        return null;
      case "unreadable":
        throw new BadVerbArgs(`${file} could not be read: ${content.error}`);
    }
  }

  // [LAW:no-silent-failure] A click reads and writes only its session's
  // layers: any other file is refused, never read from somewhere else.
  private layerAt(file: string): Layer {
    const layer = this.chain?.find((l) => l.path === file);
    if (layer === undefined)
      throw new BadVerbArgs(
        `${file} is not a layer of this session's config — its click is not taken`,
      );
    return layer;
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

  // A change of the open click to a settings file of Claude Code's, which the
  // host lands only while what it read there stands (src/doctor/gather.ts,
  // `settingChange`).
  changeSettings(file: string, change: Change): void {
    this.settings.push({ file, change });
  }

  // The open click answers the trust book for `dir`: it lands with the
  // click's changes.
  answer(dir: string, answer: RepoAnswer): void {
    this.answers.push({ dir, answer });
  }

  // The open click is over. Its changes and its answers join its turn's
  // effects, and its consequence waits for them; a click that changed no file
  // and answered nothing has its consequence now.
  seal(
    effects: Effect[],
    session: SessionId | null,
    consequence: Consequence,
  ): void {
    const answers = this.answers;
    const settings = this.settings;
    this.answers = [];
    this.settings = [];
    const written = [...this.open].flatMap(([path, { before, after }]) => {
      const list = diffChanges(before, after);
      return list.length === 0
        ? []
        : [{ path, role: this.layerAt(path).role, list }];
    });
    const files = [
      ...written.map(({ path }) => path),
      ...settings.map(({ file }) => file),
    ];
    this.open.clear();
    if (files.length === 0 && answers.length === 0) return consequence(effects);
    // [LAW:no-silent-failure] A write is a session's: one with none is the
    // click's bug.
    if (session === null)
      throw new Error(
        `a click with no session wrote ${[...files, ...answers.map((a) => `the answer for ${a.dir}`)].join(", ")}`,
      );
    const landing: Array<
      ConfigChange | Extract<Act, { kind: "approve-repo" }>
    > = [
      ...written.map(
        ({ role, list }): ConfigChange => ({
          kind: "change",
          id: this.mint(),
          session,
          target: { kind: "layer", role },
          changes: list,
        }),
      ),
      ...settings.map(
        ({ file, change }): ConfigChange => ({
          kind: "change",
          id: this.mint(),
          session,
          target: { kind: "claude-settings", file },
          changes: [change],
        }),
      ),
      ...answers.map(({ dir, answer }) => ({
        kind: "approve-repo" as const,
        id: this.mint(),
        session,
        dir,
        answer,
      })),
    ];
    this.landing = {
      of: { session, files, answered: answers.length > 0, consequence },
      owed: new Set(landing.map((c) => c.id)),
      missed: null,
    };
    effects.push(...landing);
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
    return { ...landing.of, outcome: landing.missed ?? { kind: "ok" } };
  }

  // No click begins after this: the daemon is closing.
  close(): void {
    this.closed = true;
  }
}
