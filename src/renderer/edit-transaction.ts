// A renderer-local edit transaction over the host's last committed snapshot.
// Closing the transaction releases the draft; only Save sends changes to the host.
// [LAW:one-source-of-truth] The open edit holds every session write made
// inside it, as it holds file changes: save commits what persists, and cancel
// drops it all, so the menus a user opened or closed while editing return to
// how they were. Edit mode's own keys live only here: the click that opens an
// edit hands it its first writes, and no other route reaches the store.

import { observable, runInAction } from "mobx";
import {
  contentOfText,
  layerAtPath,
  layerForRole,
  type ConfigSnapshot,
  type Layer,
  type LayerContent,
} from "../config/config-snapshot.js";
import { requireLayerText } from "./config-writes.js";
import {
  addressText,
  applyChanges,
  diffChanges,
} from "../config/config-changes.js";
import { originKey, type RenderOrigin } from "../config-hint.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import { BadVerbArgs } from "../daemon/foundations/verb-error.js";
import { isEditSettingKey } from "../renderer-interface/history-storage.js";
import { isEditModeKey, isReservedName } from "../config/reserved-names.js";
import type { SessionStateRW } from "../renderer-interface/session-state.js";
import type { DaemonLogger } from "../utils/logger.js";
import {
  SettingsHistory,
  type ConfigFiles,
  type HistoryDepth,
  type Journal,
} from "./settings-history.js";

// [LAW:types-are-the-program] An edit turn can keep editing, save, or cancel.
// Only Save opens a journal over committed settings and stages host writes.
export type EditFinish = "save" | "cancel";

export interface EditTurn {
  readonly files: ConfigFiles;
  readonly journal: Journal;
  commit(): boolean;
  save(committed: Journal, files: ConfigFiles, latest: ConfigSnapshot): void;
  // The click that leaves the edit without saving: `own`, its own writes,
  // land outside edit mode (the door it closed); everything else the edit
  // held drops.
  leave(own: ReadonlyMap<string, string | null>): void;
}

class EditDraft {
  // Every write this session made inside the edit, as the edit reads it,
  // from the writes of the click that opened it on.
  private readonly writes: Map<string, string | null>;
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
    first: ReadonlyMap<string, string | null>,
  ) {
    this.writes = new Map(first);
    this.latest = this.snapshot = base;
    // [LAW:one-type-per-behavior] The same undo step and journal serve a
    // draft. Only the journal's destination changes. A menu's state is no
    // setting, so opening one never adds an edit step.
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
      {},
      isEditSettingKey,
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
        const base = layerAtPath(this.base.chain, layer.path);
        if (base?.role !== layer.role) return [];
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

  // Cancel drops every write the edit holds. The bar's own menus and
  // chrome reopen as they were, but a setting, a draft or an author's own
  // state is work, which the count shows and a timer must not abandon.
  depth(): HistoryDepth {
    return {
      ...this.history.depth(this.session),
      sinceEdit:
        [...this.writes.keys()].filter(
          (key) => isEditSettingKey(key) || !isReservedName(key),
        ).length + this.files.size,
    };
  }

  read(key: string): string | null {
    if (this.writes.has(key)) return this.writes.get(key)!;
    return this.committed.get(this.session, key);
  }

  put(sid: SessionId, key: string, value: string | null): void {
    if (sid !== this.session) {
      if (value === null) this.committed.clear(sid, key);
      else this.committed.set(sid, key, value);
    } else if (this.committed.get(sid, key) === value) this.writes.delete(key);
    else this.writes.set(key, value);
  }

  begin(prove: ConfigFiles["prove"]): EditTurn {
    const working = new Map(this.files);
    const layerAt = (file: string): Layer => {
      const layer = layerAtPath(this.base.chain, file);
      if (layer === undefined)
        throw new BadVerbArgs(`${file} is not a layer of this edit`);
      return layer;
    };
    const files: ConfigFiles = {
      read: (file) =>
        working.has(file)
          ? contentOfText(working.get(file)!)
          : layerAt(file).content,
      land: (file, _before, after) => {
        if (after === requireLayerText(file, layerAt(file).content))
          working.delete(file);
        else working.set(file, after);
      },
      roleOf: (file) => layerAt(file).role,
      pathOf: (role) => layerForRole(this.base.chain, role)?.path ?? null,
      prove,
    };
    const journal = this.history.begin(files);
    return {
      files,
      journal,
      commit: () => {
        const stateMoved = [...journal.writes(this.session)].some(
          ([key, value]) => this.read(key) !== value,
        );
        journal.commit();
        if (sameFiles(working, this.files)) return stateMoved;
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
          const target = layerForRole(latest.chain, source.role);
          if (target?.path !== path)
            throw new BadVerbArgs(
              `save: the ${source.role} layer for this edit moved`,
            );
          const applied = applyChanges(
            requireLayerText(path, target.content),
            diffChanges(requireLayerText(path, source.content), after),
          );
          if (applied.kind !== "applied")
            throw new BadVerbArgs(
              `save: ${addressText(applied.at)} in the ${source.role} layer changed while editing`,
            );
          rewritten.set(path, applied.text);
        }
        const read = (file: string): LayerContent =>
          rewritten.has(file)
            ? contentOfText(rewritten.get(file)!)
            : destination.read(file);
        for (const [file, text] of rewritten)
          destination.prove(file, text, read);
        for (const [file, text] of rewritten)
          committedJournal.file(
            this.session,
            file,
            requireLayerText(file, destination.read(file)),
            text,
          );
        // The save click's own writes take precedence over the current draft,
        // including releasing picks it moved into durable layers.
        this.land(
          committedJournal.sessionState,
          new Map([...this.writes, ...journal.writes(this.session)]),
        );
      },
      leave: (own) => this.land(this.committed, own),
    };
  }

  // [LAW:single-enforcer] The edit's writes, landed past it: edit mode's own
  // keys end with the edit, and the rest persist.
  private land(
    into: SessionStateRW,
    writes: ReadonlyMap<string, string | null>,
  ): void {
    for (const [key, value] of writes) {
      if (isEditModeKey(key)) continue;
      if (value === null) into.clear(this.session, key);
      else into.set(this.session, key, value);
    }
  }
}

// [LAW:single-enforcer] Where a click outside an edit writes: the store's
// journal, but for edit mode's own keys, which it holds aside. They are the
// first writes of the edit the click opens, or nothing, when it opens none,
// so neither the store nor its undo history ever holds one.
export function outsideEdit(journal: SessionStateRW): {
  readonly sessionState: SessionStateRW;
  readonly held: (sid: SessionId) => ReadonlyMap<string, string | null>;
} {
  const aside = new Map<SessionId, Map<string, string | null>>();
  const write = (
    sid: SessionId,
    pairs: ReadonlyArray<{
      readonly key: string;
      readonly value: string | null;
    }>,
  ): void => {
    const store: Array<{ key: string; value: string }> = [];
    for (const { key, value } of pairs) {
      if (isEditModeKey(key))
        aside.set(sid, (aside.get(sid) ?? new Map()).set(key, value));
      else if (value === null) journal.clear(sid, key);
      else store.push({ key, value });
    }
    if (store.length > 0) journal.setBatch(sid, store);
  };
  return {
    sessionState: {
      get: (sid, key) =>
        isEditModeKey(key)
          ? (aside.get(sid)?.get(key) ?? null)
          : journal.get(sid, key),
      revision: (sid) => journal.revision(sid),
      set: (sid, key, value) => write(sid, [{ key, value }]),
      setBatch: write,
      clear: (sid, key) => write(sid, [{ key, value: null }]),
    },
    held: (sid) => aside.get(sid) ?? new Map(),
  };
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

  // [LAW:one-source-of-truth] The session's state as every reader sees it:
  // its open edit's, else the store's.
  readonly view: SessionStateRW = {
    get: (sid, key) => {
      const draft = this.draft(sid);
      return draft === null ? this.committed.get(sid, key) : draft.read(key);
    },
    revision: (sid) =>
      this.committed.revision(sid) + (this.entries.get(sid)?.revision ?? 0),
    set: (sid, key, value) => this.write(sid, [{ key, value }]),
    setBatch: (sid, pairs) => this.write(sid, pairs),
    clear: (sid, key) => this.write(sid, [{ key, value: null }]),
  };

  // A write outside a click (a failure the bar shows) lands where the session
  // reads: its open edit, else the store.
  private write(
    sid: SessionId,
    pairs: ReadonlyArray<{
      readonly key: string;
      readonly value: string | null;
    }>,
  ): void {
    const draft = this.draft(sid);
    runInAction(() => {
      for (const { key, value } of pairs)
        if (draft !== null) draft.put(sid, key, value);
        else if (value === null) this.committed.clear(sid, key);
        else this.committed.set(sid, key, value);
    });
    if (draft !== null) this.changed(sid);
  }

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

  // `first` is what the click that opens it wrote to edit mode's keys.
  open(
    sid: SessionId,
    origin: RenderOrigin,
    snapshot: ConfigSnapshot,
    first: ReadonlyMap<string, string | null>,
  ): void {
    this.update(
      sid,
      new EditDraft(sid, origin, snapshot, this.committed, this.log, first),
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
