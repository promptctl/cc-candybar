// A renderer-local edit transaction over the host's last committed snapshot.
// Closing the transaction releases the draft; only Save sends changes to the host.

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
  EDIT_MODE_REF,
} from "../config/loader/edit-mode.js";
import type { Disclosure } from "../config/disclosure.js";
import { disclosureNest } from "../config/disclosure-nest.js";
import type { DslConfig } from "../config/dsl-types.js";
import { menuPageKey } from "../config/menu-keys.js";
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

// [LAW:types-are-the-program] An edit turn can keep editing, save, or cancel.
// Only Save opens a journal over committed settings and stages host writes.
export type EditFinish = "save" | "cancel";

export interface EditTurn {
  readonly files: ConfigFiles;
  readonly journal: Journal;
  commit(): boolean;
  save(committed: Journal, files: ConfigFiles, latest: ConfigSnapshot): void;
}

// Edit mode open, as the disclosure its chrome sits inside.
const EDIT_MODE: Disclosure = EDIT_MODE_REF;

// [LAW:one-source-of-truth] The session keys edit chrome's state lives at:
// every disclosure inside edit mode (a ✚ library, configure and its lists,
// the help, the view toggle) and the page cursor each derives. Read off the
// config, so a control added inside edit mode is the edit's with no list to
// keep.
function editOwnedKeys(config: DslConfig): ReadonlySet<string> {
  return new Set(
    disclosureNest(config)
      .inside(EDIT_MODE)
      .flatMap(({ key }) => [key, menuPageKey(key)]),
  );
}

// [LAW:one-source-of-truth] What a layout change ends in a session, named by
// the declarations that minted it: every key the layout before declares state
// at and the layout after does not (an ended placement's drafts, its chrome's
// libraries, lists and pages, its own menus), and every key still declared
// whose open member only the layout before hangs (configure on an ended
// placement, an accordion open on its menu). Only keys holding a value.
// [LAW:dataflow-not-control-flow] No branch on what changed the layout: a
// change that ends nothing releases nothing.
function releasedKeys(
  before: DslConfig,
  after: DslConfig,
  read: (key: string) => string | null,
): readonly string[] {
  const declared = (config: DslConfig): Set<string> =>
    new Set(
      Object.values(config.variables).flatMap((v) =>
        v.kind === "state" ? [v.key] : [],
      ),
    );
  const kept = declared(after);
  const id = ({ key, member }: Disclosure): string => `${key}\0${member}`;
  const hung = new Set(disclosureNest(after).menus.map(id));
  return [
    ...new Set([
      ...[...declared(before)].filter((key) => !kept.has(key)),
      ...disclosureNest(before)
        .menus.filter((d) => !hung.has(id(d)) && read(d.key) === d.member)
        .map((d) => d.key),
    ]),
  ].filter((key) => read(key) !== null);
}

class EditDraft {
  readonly navigationScope = Symbol();
  private readonly picks = new Map<string, string | null>();
  // [LAW:one-source-of-truth] Edit chrome's state belongs to the open edit:
  // held here beside the drafts, outside the undo history, and never written
  // to the session store, so it is never saved and dies with the edit.
  private readonly chrome = new Map<string, string>();
  private files = new Map<string, string | null>();
  private readonly history: SettingsHistory;
  // The session store as the draft holds it: what the journal lands in.
  private readonly store: SessionStateRW;
  private latest: ConfigSnapshot;
  snapshot: ConfigSnapshot;
  // The keys the draft's chrome holds in the config it renders.
  private owned: ReadonlySet<string>;

  constructor(
    private readonly session: SessionId,
    readonly origin: RenderOrigin,
    private readonly base: ConfigSnapshot,
    private readonly committed: SessionStateRW,
    // The config `base` loads to, which the session renders as it opens.
    private layout: DslConfig,
    private readonly log: DaemonLogger,
  ) {
    this.latest = this.snapshot = base;
    this.owned = editOwnedKeys(layout);
    this.store = {
      get: (sid, key) =>
        sid === session ? this.read(key) : committed.get(sid, key),
      revision: (sid) => committed.revision(sid),
      set: (sid, key, value) => this.put(sid, key, value),
      setBatch: (sid, pairs) =>
        runInAction(() => {
          for (const { key, value } of pairs) this.put(sid, key, value);
        }),
      clear: (sid, key) => this.put(sid, key, null),
    };
    // [LAW:one-type-per-behavior] The same undo step and journal serve a
    // draft. Only the journal's destination changes. Chrome is not a setting,
    // so opening menus never adds an edit step.
    this.history = new SettingsHistory(this.store, log);
  }

  // [LAW:effects-at-boundaries] A transaction pins the content it edits.
  // The host's current layer identities and plugin discovery still decide
  // what it can load, including when the user revokes repository trust.
  // `layout` is the config the session renders, read once the draft holds
  // the snapshot it loads.
  updated(latest: ConfigSnapshot, layout: () => DslConfig): void {
    this.latest = latest;
    this.refreshSnapshot();
    this.relaid(this.store, layout(), () => {});
  }

  // [LAW:single-enforcer] THE release, at the one place the draft's layout
  // changes: a layout click, undo, redo, a reset, a preset deleted, a refresh
  // of the edit's layers. `writes` lands what it releases, through `land`:
  // the drafts as part of the click's step, so its undo brings them back.
  // Until then the keys are classed by the layout they were minted in.
  private relaid(
    writes: SessionStateRW,
    after: DslConfig,
    land: () => void,
  ): void {
    const released = releasedKeys(this.layout, after, (key) =>
      writes.get(this.session, key),
    );
    for (const key of released) writes.clear(this.session, key);
    land();
    this.layout = after;
    this.owned = editOwnedKeys(after);
    this.log(
      "info",
      `edit: layout changed released=${JSON.stringify(released)} (session=${this.session})`,
    );
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
    if (this.owned.has(key)) return this.chrome.get(key) ?? null;
    return this.committed.get(this.session, key);
  }

  // What the draft holds of a session's writes rather than the store.
  private holds(key: string): boolean {
    return isSettingKey(key) || this.owned.has(key);
  }

  // [LAW:single-enforcer] THE routing of a write the draft holds a view
  // over: a setting is a pick, chrome is the edit's own, and anything else
  // lands in `store` — the session store, or the save click's journal.
  private put(
    sid: SessionId,
    key: string,
    value: string | null,
    store: SessionStateRW = this.committed,
  ): void {
    if (sid === this.session) {
      if (key === EDIT_MODE_KEY) return;
      if (isSettingKey(key)) {
        if (this.committed.get(sid, key) === value) this.picks.delete(key);
        else this.picks.set(key, value);
        return;
      }
      if (this.owned.has(key)) {
        if (value === null) this.chrome.delete(key);
        else this.chrome.set(key, value);
        return;
      }
    }
    if (value === null) store.clear(sid, key);
    else store.set(sid, key, value);
  }

  // `layout` reads the config the session renders, as `updated` does.
  begin(prove: ConfigFiles["prove"], layout: () => DslConfig): EditTurn {
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
        const heldMoved = [...journal.writes(this.session)].some(
          ([key, value]) => this.holds(key) && this.read(key) !== value,
        );
        if (sameFiles(working, this.files)) {
          journal.commit();
          return heldMoved;
        }
        this.files = working;
        this.refreshSnapshot();
        this.relaid(journal.sessionState, layout(), () => journal.commit());
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
        for (const [file, text] of rewritten)
          destination.prove(file, text, read);
        for (const [file, text] of rewritten)
          committedJournal.file(
            this.session,
            file,
            requireLayerText(file, destination.read(file)),
            text,
          );
        // The save click's own writes pass the draft's routing first, so they
        // take precedence over the picks (releasing those it moved into
        // durable layers), and edit mode and its chrome end with the edit.
        // What reaches the store lands in the save click's journal.
        const store = committedJournal.sessionState;
        for (const [key, value] of journal.writes(this.session))
          this.put(this.session, key, value, store);
        for (const [key, value] of this.picks)
          if (value === null) store.clear(this.session, key);
          else store.set(this.session, key, value);
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

  // `layoutOf` reads the config a session renders: its draft's, once the
  // draft holds the snapshot it loads.
  configured(
    origin: RenderOrigin,
    snapshot: ConfigSnapshot,
    layoutOf: (sid: SessionId) => DslConfig,
  ): SessionId[] {
    const key = originKey(origin);
    const refreshed: SessionId[] = [];
    for (const [sid, { draft }] of this.entries) {
      if (draft === null || originKey(draft.origin) !== key) continue;
      draft.updated(snapshot, () => layoutOf(sid));
      this.changed(sid);
      refreshed.push(sid);
    }
    return refreshed;
  }

  depth(sid: SessionId, committed: SettingsHistory): HistoryDepth {
    return this.draft(sid)?.depth() ?? committed.depth(sid);
  }

  // `layout` is the config `snapshot` loads to: what the session renders.
  open(
    sid: SessionId,
    origin: RenderOrigin,
    snapshot: ConfigSnapshot,
    layout: DslConfig,
  ): void {
    this.update(
      sid,
      new EditDraft(sid, origin, snapshot, this.committed, layout, this.log),
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
