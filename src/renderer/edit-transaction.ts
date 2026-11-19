// A renderer-local edit transaction over the host's last committed snapshot.
// Closing the transaction releases the draft; only Save sends changes to the host.

import { observable, runInAction } from "mobx";
import type { ConfigSnapshot, Layer } from "../config/config-snapshot.js";
import { writable } from "../config/config-snapshot.js";
import {
  addressText,
  applyChanges,
  diffChanges,
} from "../config/config-changes.js";
import {
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
} from "../config/loader/edit-mode.js";
import { originKey, type RenderOrigin } from "../config-hint.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import { BadVerbArgs } from "../daemon/foundations/verb-error.js";
import { isSettingKey } from "../renderer-interface/history-storage.js";
import type { SessionStateRW } from "../renderer-interface/session-state.js";
import type { DaemonLogger } from "../utils/logger.js";
import {
  SettingsHistory,
  type ConfigFiles,
  type HistoryDepth,
  type Journal,
} from "./settings-history.js";

function textOf(layer: Layer): string | null {
  if (!writable(layer.content))
    throw new BadVerbArgs(
      `${layer.path} is unreadable: ${layer.content.error}`,
    );
  return layer.content.kind === "text" ? layer.content.text : null;
}

// [LAW:types-are-the-program] An edit turn can keep editing, save, or cancel.
// Only Save opens a journal over committed settings and stages host writes.
export type EditFinish = "save" | "cancel";

export interface EditTurn {
  readonly files: ConfigFiles;
  readonly journal: Journal;
  commit(): boolean;
  save(committed: Journal, files: ConfigFiles, latest: ConfigSnapshot): void;
}

class EditDraft {
  private readonly picks = new Map<string, string | null>();
  private files = new Map<string, string | null>();
  private readonly history: SettingsHistory;
  private latest: ConfigSnapshot;
  snapshot: ConfigSnapshot;

  constructor(
    private readonly session: SessionId,
    readonly origin: RenderOrigin,
    private readonly base: ConfigSnapshot,
    private readonly committed: SessionStateRW,
    log: DaemonLogger,
  ) {
    this.latest = this.snapshot = base;
    // [LAW:one-type-per-behavior] The same undo step and journal serve a
    // draft. Only the journal's destination changes. Chrome still uses the
    // normal session store, so opening menus never adds an edit step.
    this.history = new SettingsHistory(
      {
        get: (sid, key) =>
          sid === session ? this.read(key) : committed.get(sid, key),
        revision: (sid) => committed.revision(sid),
        set: (sid, key, value) => this.put(sid, key, value),
        setBatch: (sid, pairs) =>
          runInAction(() => {
            for (const { key, value } of pairs) this.put(sid, key, value);
          }),
        clear: (sid, key) => this.put(sid, key, null),
      },
      log,
    );
  }

  // [LAW:effects-at-boundaries] A transaction pins the content it edits.
  // The host's current layer identities and plugin discovery still decide
  // what it can load, including when the user revokes repository trust.
  updated(latest: ConfigSnapshot): void {
    this.latest = latest;
    this.refreshSnapshot();
  }

  private refreshSnapshot(): void {
    this.snapshot = {
      ...this.latest,
      chain: this.latest.chain.flatMap((layer) => {
        const base = this.base.chain.find(
          (candidate) =>
            candidate.path === layer.path && candidate.role === layer.role,
        );
        if (base === undefined) return [];
        const value = this.files.get(layer.path);
        const content =
          value === undefined
            ? base.content
            : value === null
              ? { kind: "absent" as const }
              : { kind: "text" as const, text: value };
        return [{ ...layer, content }];
      }),
    };
  }

  depth(): HistoryDepth {
    return {
      ...this.history.depth(this.session),
      sinceEdit: this.picks.size + this.files.size,
    };
  }

  read(key: string): string | null {
    if (key === EDIT_MODE_KEY) return EDIT_MODE_ARRANGE;
    if (this.picks.has(key)) return this.picks.get(key)!;
    return this.committed.get(this.session, key);
  }

  private put(sid: SessionId, key: string, value: string | null): void {
    if (sid === this.session) {
      if (key === EDIT_MODE_KEY) return;
      if (isSettingKey(key)) {
        if (this.committed.get(sid, key) === value) this.picks.delete(key);
        else this.picks.set(key, value);
        return;
      }
    }
    if (value === null) this.committed.clear(sid, key);
    else this.committed.set(sid, key, value);
  }

  begin(prove: ConfigFiles["prove"]): EditTurn {
    const working = new Map(this.files);
    const layerAt = (file: string): Layer => {
      const layer = this.base.chain.find((layer) => layer.path === file);
      if (layer === undefined)
        throw new BadVerbArgs(`${file} is not a layer of this edit`);
      return layer;
    };
    const files: ConfigFiles = {
      read: (file) =>
        working.has(file) ? working.get(file)! : textOf(layerAt(file)),
      land: (file, _before, after) => {
        if (after === textOf(layerAt(file))) working.delete(file);
        else working.set(file, after);
      },
      roleOf: (file) => layerAt(file).role,
      pathOf: (role) =>
        this.base.chain.find((layer) => layer.role === role)?.path ?? null,
      prove,
    };
    const journal = this.history.begin(files);
    return {
      files,
      journal,
      commit: () => {
        const picksMoved = [...journal.writes(this.session)].some(
          ([key, value]) => isSettingKey(key) && this.read(key) !== value,
        );
        journal.commit();
        if (sameFiles(working, this.files)) return picksMoved;
        this.files = working;
        this.refreshSnapshot();
        return true;
      },
      save: (committedJournal, destination, latest) => {
        // [LAW:single-enforcer] Use the same guarded change algebra as the
        // host. Disjoint edits can coexist; a conflicting address or moved
        // layer leaves the transaction open with the preview as it was.
        const rewritten = new Map<string, string | null>();
        for (const [path, after] of working) {
          const source = layerAt(path);
          const target = latest.chain.find(
            (layer) => layer.role === source.role,
          );
          if (target?.path !== path)
            throw new BadVerbArgs(
              `save: the ${source.role} layer for this edit moved`,
            );
          const applied = applyChanges(
            textOf(target),
            diffChanges(textOf(source), after),
          );
          if (applied.kind !== "applied")
            throw new BadVerbArgs(
              `save: ${addressText(applied.at)} in the ${source.role} layer changed while editing`,
            );
          rewritten.set(path, applied.text);
        }
        const read = (file: string): string | null =>
          rewritten.has(file) ? rewritten.get(file)! : destination.read(file);
        for (const [file, text] of rewritten)
          destination.prove(file, text, read);
        for (const [file, text] of rewritten)
          committedJournal.file(
            this.session,
            file,
            destination.read(file),
            text,
          );
        // The save click's own writes take precedence over the current draft,
        // including releasing picks it moved into durable layers.
        for (const [key, value] of new Map([
          ...this.picks,
          ...journal.writes(this.session),
        ])) {
          if (key === EDIT_MODE_KEY) continue;
          if (value === null)
            committedJournal.sessionState.clear(this.session, key);
          else committedJournal.sessionState.set(this.session, key, value);
        }
      },
    };
  }
}

function sameFiles(
  left: ReadonlyMap<string, string | null>,
  right: ReadonlyMap<string, string | null>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([key, value]) => right.get(key) === value)
  );
}

interface Entry {
  readonly draft: EditDraft | null;
  readonly revision: number;
}

// [LAW:one-source-of-truth] The transaction is the only owner of edit mode.
// Each session's view overlays exactly its own draft; no draft is persisted.
export class EditTransactions {
  private readonly entries = observable.map<SessionId, Entry>(undefined, {
    deep: false,
  });

  constructor(
    readonly committed: SessionStateRW,
    private readonly log: DaemonLogger,
  ) {}

  readonly view: SessionStateRW = {
    get: (sid, key) => {
      const draft = this.draft(sid);
      if (draft !== null) return draft.read(key);
      // Ignore the edit-mode flag saved by versions with committed savepoints.
      return key === EDIT_MODE_KEY ? null : this.committed.get(sid, key);
    },
    revision: (sid) =>
      this.committed.revision(sid) + (this.entries.get(sid)?.revision ?? 0),
    set: (sid, key, value) => this.committed.set(sid, key, value),
    setBatch: (sid, pairs) => this.committed.setBatch(sid, pairs),
    clear: (sid, key) => this.committed.clear(sid, key),
  };

  draft(sid: SessionId): EditDraft | null {
    return this.entries.get(sid)?.draft ?? null;
  }

  snapshot(origin: RenderOrigin, sid: SessionId): ConfigSnapshot | null {
    const draft = this.draft(sid);
    return draft !== null && originKey(draft.origin) === originKey(origin)
      ? draft.snapshot
      : null;
  }

  configured(origin: RenderOrigin, snapshot: ConfigSnapshot): SessionId[] {
    const key = originKey(origin);
    const refreshed: SessionId[] = [];
    for (const [sid, { draft }] of this.entries) {
      if (draft === null || originKey(draft.origin) !== key) continue;
      draft.updated(snapshot);
      refreshed.push(sid);
    }
    return refreshed;
  }

  depth(sid: SessionId, committed: SettingsHistory): HistoryDepth {
    return this.draft(sid)?.depth() ?? committed.depth(sid);
  }

  open(sid: SessionId, origin: RenderOrigin, snapshot: ConfigSnapshot): void {
    this.update(
      sid,
      new EditDraft(sid, origin, snapshot, this.committed, this.log),
    );
  }

  close(sid: SessionId): void {
    this.update(sid, null);
  }

  changed(sid: SessionId): void {
    this.update(sid, this.draft(sid));
  }

  moved(sid: SessionId, origin: RenderOrigin): boolean {
    const draft = this.draft(sid);
    if (draft === null || originKey(draft.origin) === originKey(origin))
      return false;
    this.log(
      "info",
      `edit: draft discarded after the session changed config origin (session=${sid})`,
    );
    this.close(sid);
    return true;
  }

  retire(sid: SessionId): void {
    runInAction(() => this.entries.delete(sid));
  }

  private update(sid: SessionId, draft: EditDraft | null): void {
    const revision = (this.entries.get(sid)?.revision ?? 0) + 1;
    runInAction(() => this.entries.set(sid, { draft, revision }));
  }
}
