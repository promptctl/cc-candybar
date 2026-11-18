// [LAW:single-enforcer] How a click's config writes leave the renderer: as
// `change`s its turn returns, which the host performs, never as a file the
// renderer writes, and with them its answers to the trust book, which decide
// which config a session renders. A click reads and writes only the layers of
// its session's origin, from the snapshot the host handed in for it, and
// each change names its layer by that origin and its role. A click lands
// whole or not at all, so what else it did is its consequence (its journal's
// commit), held here from its turn until its changes' `effect-done`s: applied
// once they land, dropped when they do not. The host lands a turn's changes, and hands in their
// `effect-done`s, before the renderer's next input (src/daemon/renderer-host.ts),
// so each click reads the snapshot the clicks ahead of it moved, and at most
// one click is ever landing.

import { diffChanges, type Change } from "../config/config-changes.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import {
  BadVerbArgs,
  DaemonClosing,
} from "../daemon/foundations/verb-error.js";
import type { RepoAnswer } from "../config/loader/repo-gate.js";
import type { Layer } from "../config/config-snapshot.js";
import type { RenderOrigin } from "../config-hint.js";
import type { LayerRole } from "../config/layer-role.js";
import type {
  Act,
  ConfigChange,
  OwedEffect,
  EffectId,
  EffectOutcome,
} from "../renderer-interface/interface.js";

// What a click's consequence is applied in: the turn its changes landed in,
// whose effects what it asks joins.
export type Consequence = (effects: OwedEffect[]) => void;

// A click whose changes are on their way: the session it clicked, the files
// they change, and its consequence.
export interface Landing {
  readonly session: SessionId;
  // The origin whose layers the click read: none for a click that read none.
  readonly origin: RenderOrigin | null;
  readonly files: readonly string[];
  readonly consequence: Consequence;
}

// How a landing ended: every change of its click landed, or the first reason
// one did not.
export type Landed = Landing & { readonly outcome: EffectOutcome };

// [LAW:one-source-of-truth] The layers a click may read and write: its
// session's recorded origin, and that origin's chain as the snapshot the
// renderer holds for it says. Asked for only once the click reads a layer, so
// a click that writes none needs no snapshot; one that is not held throws,
// naming the origin.
export interface ClickLayers {
  readonly origin: RenderOrigin;
  readonly chain: readonly Layer[];
}

// No click is open: nothing reads a layer.
const noLayers = (): ClickLayers => {
  throw new Error("a config layer was read with no click open");
};

export class ConfigWrites {
  // The open click's writes, by file: what it read first, and wrote last.
  private readonly open = new Map<
    string,
    { readonly before: string | null; readonly after: string | null }
  >();
  private inFlight: {
    readonly of: Landing;
    readonly owed: Set<EffectId>;
    missed: Exclude<EffectOutcome, { kind: "ok" }> | null;
  } | null = null;
  private closed = false;
  // The open click's changes to Claude Code's settings, which no renderer
  // reads: each made against what the session's doctor reading saw.
  private settings: Array<{ readonly file: string; readonly change: Change }> =
    [];
  // The open click's answers to the trust book, in the order it gave them.
  private answers: Array<{
    readonly origin: RenderOrigin;
    readonly dir: string;
    readonly answer: RepoAnswer;
  }> = [];
  // The open click's layers, asked for once it first reads one.
  private layersOf: () => ClickLayers = noLayers;
  private layers: ClickLayers | null = null;

  constructor(private readonly mint: () => EffectId) {}

  // A click's journal opens over its session's layers: refused once the
  // daemon's close has begun, so a click the close cut off writes nothing.
  // [LAW:no-silent-failure] A landing still owed here is the host's bug: it
  // hands a turn's `effect-done`s in before the next input.
  begin(verb: string, layers: () => ClickLayers): void {
    if (this.closed) throw new DaemonClosing(verb);
    if (this.inFlight !== null)
      throw new Error(
        `${verb} began while a click's changes to ${this.inFlight.of.files.join(", ")} were still landing`,
      );
    this.layersOf = layers;
    this.layers = null;
  }

  // [LAW:one-source-of-truth] `file` as the open click left it: its last
  // write, else the text its origin's snapshot holds, which every click ahead
  // of it moved. A layer that could not be read is no layer here, as it is
  // none of the merge.
  read(file: string): string | null {
    const written = this.open.get(file);
    if (written !== undefined) return written.after;
    const { content } = this.layerAt(file);
    return content.kind === "text" ? content.text : null;
  }

  // [LAW:no-silent-failure] The layer of the click's chain at `file`: a file
  // the chain does not hold is no layer a click of this session writes.
  private layerAt(file: string): Layer {
    const layer = this.held().chain.find((l) => l.path === file);
    if (layer === undefined)
      throw new BadVerbArgs(
        `${file} is not a config file this session renders from — the click is not taken`,
      );
    return layer;
  }

  private held(): ClickLayers {
    return (this.layers ??= this.layersOf());
  }

  // The role of the click's chain at `file`.
  roleOf(file: string): LayerRole {
    return this.layerAt(file).role;
  }

  // The file of the click's chain at `role`: null when the chain holds no
  // layer of that role.
  pathOf(role: LayerRole): string | null {
    return this.held().chain.find((l) => l.role === role)?.path ?? null;
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
    this.answers.push({ origin: this.held().origin, dir, answer });
  }

  // The open click is over. Its changes and its answers join its turn's
  // effects, and its consequence waits for them; a click that changed no file
  // and answered nothing has its consequence now.
  seal(
    effects: OwedEffect[],
    session: SessionId | null,
    consequence: Consequence,
  ): void {
    const answers = this.answers;
    const settings = this.settings;
    this.answers = [];
    this.settings = [];
    // [LAW:no-ambient-temporal-coupling] The click is over even when reading
    // its layers throws, so the next click opens on nothing of this one's.
    let written;
    let origin: RenderOrigin | null = null;
    try {
      written = [...this.open].flatMap(([path, { before, after }]) => {
        const list = diffChanges(before, after);
        return list.length === 0
          ? []
          : [
              {
                path,
                origin: this.held().origin,
                role: this.roleOf(path),
                list,
              },
            ];
      });
    } finally {
      origin = this.layers?.origin ?? null;
      this.layers = null;
      this.layersOf = noLayers;
      this.open.clear();
    }
    const files = [
      ...written.map(({ path }) => path),
      ...settings.map(({ file }) => file),
    ];
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
        ({ origin, role, list }): ConfigChange => ({
          kind: "change",
          id: this.mint(),
          session,
          target: { kind: "layer", origin, role },
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
      ...answers.map(({ origin, dir, answer }) => ({
        kind: "approve-repo" as const,
        id: this.mint(),
        session,
        origin,
        dir,
        answer,
      })),
    ];
    this.inFlight = {
      of: { session, origin, files, consequence },
      owed: new Set(landing.map((c) => c.id)),
      missed: null,
    };
    effects.push(...landing);
  }

  // A change's `effect-done`: the landing once its last change is settled,
  // `owed` while others are still on their way, or undefined for an id no
  // change of this renderer's holds.
  settled(id: EffectId, outcome: EffectOutcome): Landed | "owed" | undefined {
    const landing = this.inFlight;
    if (landing === null || !landing.owed.delete(id)) return undefined;
    if (outcome.kind !== "ok") landing.missed ??= outcome;
    if (landing.owed.size > 0) return "owed";
    this.inFlight = null;
    return { ...landing.of, outcome: landing.missed ?? { kind: "ok" } };
  }

  // The origin of the click whose changes are on their way, if one's are.
  landing(): RenderOrigin | null {
    return this.inFlight?.of.origin ?? null;
  }

  // No click begins after this: the daemon is closing.
  close(): void {
    this.closed = true;
  }
}
