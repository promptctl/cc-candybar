// A renderer-local edit transaction over the host's last committed snapshot.
// Closing the transaction releases the draft; only Save sends changes to the host.
// The edit also holds its own chrome — the open or closed state of edit mode's
// controls — so chrome dies with the edit by any route, and the persisted
// session store never holds it.

import { observable, runInAction } from "mobx";
import {
  contentOfText,
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
import {
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
} from "../config/loader/edit-mode.js";
import { originKey, type RenderOrigin } from "../config-hint.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import { BadVerbArgs } from "../daemon/foundations/verb-error.js";
import { isSettingKey } from "../renderer-interface/history-storage.js";
import { isChromeKey } from "../config/reserved-names.js";
import type { StateWrite } from "../config/disclosure-nest.js";
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
}

// [LAW:single-enforcer] THE classification of a session key an edit writes:
// edit chrome stays in the edit, a setting's unsaved value is a pick the edit
// holds until save or cancel decides it, and everything else is the session's.
type Home = "chrome" | "pick" | "store";
function homeOf(key: string): Home {
  return isChromeKey(key) ? "chrome" : isSettingKey(key) ? "pick" : "store";
}

class EditDraft {
  readonly navigationScope = Symbol();
  private readonly picks = new Map<string, string | null>();
  // An open edit is arranging: its own switch is the first chrome it holds.
  private readonly chrome = new Map<string, string>([
    [EDIT_MODE_KEY, EDIT_MODE_ARRANGE],
  ]);
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
    // draft. Only the journal's destination changes. Chrome is no setting, so
    // opening menus never adds an edit step.
    const put = (sid: SessionId, key: string, value: string | null): void => {
      if (sid === session) this.put(key, value);
      else if (value === null) committed.clear(sid, key);
      else committed.set(sid, key, value);
    };
    this.history = new SettingsHistory(
      {
        get: (sid, key) =>
          sid === session ? this.read(key) : committed.get(sid, key),
        revision: (sid) => committed.revision(sid),
        set: put,
        setBatch: (sid, pairs) =>
          runInAction(() => {
            for (const { key, value } of pairs) put(sid, key, value);
          }),
        clear: (sid, key) => put(sid, key, null),
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
    switch (homeOf(key)) {
      case "chrome":
        return this.chrome.get(key) ?? null;
      case "pick":
        if (this.picks.has(key)) return this.picks.get(key)!;
        return this.committed.get(this.session, key);
      case "store":
        return this.committed.get(this.session, key);
    }
  }

  // The edit's own session's write.
  put(key: string, value: string | null): void {
    switch (homeOf(key)) {
      case "chrome":
        if (value === null) this.chrome.delete(key);
        else this.chrome.set(key, value);
        return;
      case "pick":
        if (this.committed.get(this.session, key) === value)
          this.picks.delete(key);
        else this.picks.set(key, value);
        return;
      case "store":
        if (value === null) this.committed.clear(this.session, key);
        else this.committed.set(this.session, key, value);
    }
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
        working.has(file)
          ? contentOfText(working.get(file)!)
          : layerAt(file).content,
      land: (file, _before, after) => {
        if (after === requireLayerText(file, layerAt(file).content))
          working.delete(file);
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
        // What the edit holds moved: the session's own store is observed
        // by its readers already.
        const picksMoved = [...journal.writes(this.session)].some(
          ([key, value]) => homeOf(key) !== "store" && this.read(key) !== value,
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
        const loaded = new Map(
          [...rewritten].map(([file, text]) => [
            file,
            destination.prove(file, text, read),
          ]),
        );
        for (const [file, text] of rewritten)
          committedJournal.file(
            this.session,
            file,
            requireLayerText(file, destination.read(file)),
            text,
            loaded.get(file)!,
          );
        // The save click's own writes take precedence over the current draft,
        // including releasing picks it moved into durable layers.
        for (const [key, value] of new Map([
          ...this.picks,
          ...journal.writes(this.session),
        ])) {
          if (homeOf(key) === "chrome") continue;
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

  // [LAW:single-enforcer] THE router every session write passes: a chrome key
  // goes to the session's open edit, and with none open it has no meaning, so
  // it is dropped and said; every other key goes to the persisted store.
  private readonly toStore = (
    sid: SessionId,
    key: string,
    value: string | null,
  ): void => {
    if (homeOf(key) !== "chrome") {
      if (value === null) this.store.clear(sid, key);
      else this.store.set(sid, key, value);
    } else if (this.draft(sid) === null) {
      this.log(
        "info",
        `edit: dropped ${key} — no edit is open (session=${sid})`,
      );
    } else this.toView(sid, key, value);
  };

  // A write to what the session sees: its open edit takes it, picks included.
  private readonly toView = (
    sid: SessionId,
    key: string,
    value: string | null,
  ): void => {
    const draft = this.draft(sid);
    if (draft === null) return this.toStore(sid, key, value);
    draft.put(key, value);
    this.changed(sid);
  };

  // The persisted store as every writer and the settings history see it:
  // chrome is never read from it, whatever an older build left there.
  readonly committed: SessionStateRW;
  // The session as its bar sees it: its open edit over the store.
  readonly view: SessionStateRW;

  constructor(
    private readonly store: SessionStateRW,
    private readonly log: DaemonLogger,
  ) {
    const writes = (write: typeof this.toStore) => ({
      set: write,
      setBatch: (sid: SessionId, pairs: readonly StateWrite[]) =>
        runInAction(() => {
          for (const { key, value } of pairs) write(sid, key, value);
        }),
      clear: (sid: SessionId, key: string) => write(sid, key, null),
    });
    this.committed = {
      get: (sid, key) =>
        homeOf(key) === "chrome" ? null : this.store.get(sid, key),
      revision: (sid) => this.store.revision(sid),
      ...writes(this.toStore),
    };
    this.view = {
      get: (sid, key) => {
        const draft = this.draft(sid);
        return draft === null ? this.committed.get(sid, key) : draft.read(key);
      },
      revision: (sid) =>
        this.store.revision(sid) + (this.entries.get(sid)?.revision ?? 0),
      ...writes(this.toView),
    };
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
