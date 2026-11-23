// A renderer-local edit transaction over the host's last committed snapshot.
// Closing the transaction releases the draft; only Save sends changes to the host.
// [LAW:one-source-of-truth] The open edit holds every session write made
// inside it, as it holds file changes and the Back steps taken in it: save
// commits what persists, and cancel drops it all, so the menus a user opened
// or closed while editing return to how they were. Edit mode's own keys live
// only here: every session write passes one router (routedWrites), which
// hands a session's writes to its open edit, and with none open sets edit
// mode's keys aside, so the store never holds one.

import { observable, runInAction } from "mobx";
import {
  contentOfText,
  layerAtPath,
  layerForRole,
  revisionOf,
  type ConfigRevision,
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
import { isEditModeKey, isHeldByEdit } from "../config/session-key.js";
import type { SessionStateRW } from "../renderer-interface/session-state.js";
import { NavigationHistory } from "./navigation-history.js";
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

export type SessionWrites = ReadonlyMap<string, string | null>;

export interface EditTurn {
  readonly files: ConfigFiles;
  readonly journal: Journal;
  // The edit's own Back steps, which end with it.
  readonly navigation: NavigationHistory;
  // Whether the edit moved, and the click's own writes, handed back as the
  // value the commit landed.
  commit(): { readonly moved: boolean; readonly clicked: SessionWrites };
  save(committed: Journal, files: ConfigFiles, latest: ConfigSnapshot): void;
  // The click that leaves the edit without saving: `clicked`, its own writes,
  // land outside edit mode (the door it closed); everything else the edit
  // held drops.
  leave(clicked: SessionWrites): void;
}

// A session's open edit, as the router writes into it.
export interface DraftWrites {
  read(key: string): string | null;
  put(key: string, value: string | null): void;
}

// Where edit mode's keys go for a session with no edit open.
export interface Unheld {
  get(sid: SessionId, key: string): string | null;
  put(sid: SessionId, key: string, value: string | null): void;
}

type Pairs = ReadonlyArray<{
  readonly key: string;
  readonly value: string | null;
}>;

// [LAW:single-enforcer] THE decision of where a session write goes: to the
// session's open edit, whole, but for the bar's own record of a failed click
// (isHeldByEdit); with none open, edit mode's keys to `unheld` and the rest to
// `store`. Reads come back from where the writes went.
export function routedWrites(
  store: SessionStateRW,
  draftOf: (sid: SessionId) => DraftWrites | null,
  unheld: Unheld,
): SessionStateRW & { readonly write: (sid: SessionId, pairs: Pairs) => void } {
  const write = (sid: SessionId, pairs: Pairs): void => {
    const draft = draftOf(sid);
    const stored: Array<{ key: string; value: string }> = [];
    runInAction(() => {
      for (const { key, value } of pairs)
        if (draft !== null && isHeldByEdit(key)) draft.put(key, value);
        else if (isEditModeKey(key)) unheld.put(sid, key, value);
        else if (value === null) store.clear(sid, key);
        else stored.push({ key, value });
      if (stored.length > 0) store.setBatch(sid, stored);
    });
  };
  return {
    get: (sid, key) => {
      const draft = draftOf(sid);
      return draft !== null && isHeldByEdit(key)
        ? draft.read(key)
        : isEditModeKey(key)
          ? unheld.get(sid, key)
          : store.get(sid, key);
    },
    revision: (sid) => store.revision(sid),
    set: (sid, key, value) => write(sid, [{ key, value }]),
    setBatch: write,
    clear: (sid, key) => write(sid, [{ key, value: null }]),
    write,
  };
}

// Edit mode's keys held aside by a click outside an edit: the first writes of
// the edit it opens, or nothing, when it opens none.
export function heldAside(): Unheld & {
  readonly held: (sid: SessionId) => SessionWrites;
} {
  const aside = new Map<SessionId, Map<string, string | null>>();
  return {
    get: (sid, key) => aside.get(sid)?.get(key) ?? null,
    put: (sid, key, value) =>
      aside.set(sid, (aside.get(sid) ?? new Map()).set(key, value)),
    held: (sid) => aside.get(sid) ?? new Map(),
  };
}

// [LAW:no-silent-failure] THE line for a write, or a save or cancel, meant for
// an edit that is not open: one drawn before the edit closed. It says what was
// dropped, in one wording wherever it happens.
export function staleEditWrite(
  log: DaemonLogger,
  sid: SessionId,
  what: Iterable<string>,
): void {
  log(
    "warn",
    `edit: dropped ${[...what].join(",")} — no edit is open (session=${sid})`,
  );
}

// Where an edit's own keys go once it ends: nowhere.
const ENDED: Unheld = { get: () => null, put: () => {} };

class EditDraft implements DraftWrites {
  // Every write this session made inside the edit, as the edit reads it,
  // from the writes of the click that opened it on.
  private readonly writes: Map<string, string | null>;
  private files = new Map<string, string | null>();
  private readonly history: SettingsHistory;
  readonly navigation = new NavigationHistory();
  private latest: ConfigSnapshot;
  // [LAW:one-source-of-truth] Derived from `latest`, `base` and the draft's
  // files, and retaken whenever one of them changes: never assigned from
  // outside the draft.
  #revision: ConfigRevision;

  constructor(
    private readonly session: SessionId,
    readonly origin: RenderOrigin,
    private readonly base: ConfigSnapshot,
    private readonly committed: SessionStateRW,
    sessions: SessionStateRW,
    log: DaemonLogger,
    first: SessionWrites,
  ) {
    this.writes = new Map(first);
    this.latest = base;
    this.#revision = revisionOf(base);
    // [LAW:one-type-per-behavior] The same undo step and journal serve a
    // draft, over the sessions as the router writes them, which hands this
    // session's writes to this draft. A menu's state is no setting, so
    // opening one never adds an edit step.
    this.history = new SettingsHistory(sessions, log, {});
  }

  // [LAW:effects-at-boundaries] A transaction pins the content it edits.
  // The host's current layer identities and plugin discovery still decide
  // what it can load, including when the user revokes repository trust.
  updated(latest: ConfigSnapshot): void {
    this.latest = latest;
    this.refreshSnapshot();
  }

  // The config the draft previews: the host's latest layers, each holding
  // the draft's text for its file.
  get revision(): ConfigRevision {
    return this.#revision;
  }

  private refreshSnapshot(): void {
    this.#revision = revisionOf({
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
    });
  }

  // The files the edit changed. Its settings and drafts are the save's own
  // count, derived over the config as the save derives them.
  depth(): HistoryDepth {
    return {
      ...this.history.depth(this.session),
      sinceEdit: this.files.size,
    };
  }

  read(key: string): string | null {
    if (this.writes.has(key)) return this.writes.get(key)!;
    return this.committed.get(this.session, key);
  }

  put(key: string, value: string | null): void {
    if (this.committed.get(this.session, key) === value)
      this.writes.delete(key);
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
      navigation: this.navigation,
      commit: () => {
        const before = new Map(this.writes);
        const clicked = journal.commit().get(this.session) ?? new Map();
        const stateMoved = !sameEntries(before, this.writes);
        if (sameEntries(working, this.files))
          return { moved: stateMoved, clicked };
        this.files = working;
        this.refreshSnapshot();
        return { moved: true, clicked };
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
      leave: (clicked) => this.land(this.committed, clicked),
    };
  }

  // The edit's writes, landed past it, through the router as for a session
  // with no edit: edit mode's own keys end with the edit, and the rest
  // persist.
  private land(into: SessionStateRW, writes: SessionWrites): void {
    routedWrites(into, () => null, ENDED).write(
      this.session,
      [...writes].map(([key, value]) => ({ key, value })),
    );
  }
}

function sameEntries(left: SessionWrites, right: SessionWrites): boolean {
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

  // [LAW:one-source-of-truth] The session's state as every reader and every
  // writer outside a click's journal sees it: its open edit's, else the
  // store's, through the one router. An edit-mode key written with no edit
  // open (a stale click's) is dropped, said.
  readonly view: SessionStateRW;

  constructor(
    readonly committed: SessionStateRW,
    private readonly log: DaemonLogger,
  ) {
    const routed = routedWrites(committed, (sid) => this.draftWrites(sid), {
      get: () => null,
      put: (sid, key) => staleEditWrite(log, sid, [key]),
    });
    this.view = {
      get: routed.get,
      set: routed.set,
      setBatch: routed.setBatch,
      clear: routed.clear,
      revision: (sid) =>
        committed.revision(sid) + (this.entries.get(sid)?.revision ?? 0),
    };
  }

  draft(sid: SessionId): EditDraft | null {
    return this.entries.get(sid)?.draft ?? null;
  }

  // The session's open edit as the router writes into it: each write a
  // change the session's view shows.
  draftWrites(sid: SessionId): DraftWrites | null {
    const draft = this.draft(sid);
    return draft === null
      ? null
      : {
          read: (key) => draft.read(key),
          put: (key, value) => {
            draft.put(key, value);
            this.changed(sid);
          },
        };
  }

  revision(origin: RenderOrigin, sid: SessionId): ConfigRevision | null {
    const draft = this.draft(sid);
    return draft !== null && originKey(draft.origin) === originKey(origin)
      ? draft.revision
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
    first: SessionWrites,
  ): void {
    this.update(
      sid,
      new EditDraft(
        sid,
        origin,
        snapshot,
        this.committed,
        this.view,
        this.log,
        first,
      ),
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
