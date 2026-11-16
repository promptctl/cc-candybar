// [LAW:single-enforcer] How a click's config write leaves the renderer: as a
// `change` its turn returns, which the host performs, never as a file the
// renderer writes. A click's writers read the file as it stands, so a click
// must not read before the changes of the clicks ahead of it have landed:
// each change is held here from the turn that returned it until its
// `effect-done`, and a journal turn opens only once none is held
// (src/renderer/journal-turns.ts). The wait is between turns, never inside
// one, and the host owes every change it is handed its `effect-done`
// (src/daemon/renderer-host.ts).

import { diffChanges } from "../config/config-changes.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import type { CheckedRenderRequest } from "../renderer-interface/request-context.js";
import type {
  ConfigChange,
  Effect,
  EffectId,
} from "../renderer-interface/interface.js";

// What a change wrote, for its `effect-done`: the clicking session, the file,
// and the session as its click's latest request reported it.
export interface ChangeOnItsWay {
  readonly session: SessionId;
  readonly path: string;
  readonly latest: CheckedRenderRequest | null;
}

export class ConfigWrites {
  // Each change on its way, and the text it leaves its file holding.
  private readonly held = new Map<
    EffectId,
    { readonly by: ChangeOnItsWay; readonly after: string | null }
  >();
  private waiting: Array<() => void> = [];

  constructor(
    private readonly mint: () => EffectId,
    // The file as it stands on disk.
    private readonly disk: (file: string) => string | null,
  ) {}

  // [LAW:one-source-of-truth] `file` as the changes on their way leave it:
  // the last one's text, else the disk's. A turn opens only once the turns
  // ahead of it have landed, so a click reads its own changes and no other's.
  read(file: string): string | null {
    const ours = [...this.held.values()].filter((h) => h.by.path === file);
    return ours.length === 0 ? this.disk(file) : ours.at(-1)!.after;
  }

  // The change from `before` to `after` in `path`, into the turn's effects. A
  // write that changes nothing is no change.
  land(
    effects: Effect[],
    by: ChangeOnItsWay,
    before: string | null,
    after: string | null,
  ): void {
    const changes = diffChanges(before, after);
    if (changes.length === 0) return;
    const change: ConfigChange = {
      kind: "change",
      id: this.mint(),
      session: by.session,
      target: { kind: "layer", path: by.path },
      changes,
    };
    this.held.set(change.id, { by, after });
    effects.push(change);
  }

  // A change's `effect-done`: what it wrote, or undefined for an id no change
  // of this renderer's holds.
  settled(id: EffectId): ChangeOnItsWay | undefined {
    const held = this.held.get(id);
    if (held === undefined) return undefined;
    this.held.delete(id);
    if (this.held.size === 0)
      for (const resume of this.waiting.splice(0)) resume();
    return held.by;
  }

  // Resolves once no change is on its way.
  landed(): Promise<void> {
    return this.held.size === 0
      ? Promise.resolve()
      : new Promise((resume) => this.waiting.push(resume));
  }
}
