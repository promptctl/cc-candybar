// An edit previews the host-owned draft over its pinned writable layers.
// Save releases it into the durable configuration. Cancel releases the preview.
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
import {
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
} from "../config/loader/edit-mode.js";
import type { SessionStateRW } from "../renderer-interface/session-state.js";
import {
  DraftBook,
  installOverride,
  pinDraft,
  type DraftBase,
  type DraftChange,
  type DraftSnapshot,
  type DraftWrite,
  type OpenDraft,
  type PinnedLayer,
} from "../renderer-interface/draft.js";
import { EMPTY_HISTORY } from "../renderer-interface/history-storage.js";
import { EMPTY_TIMELINE } from "../renderer-interface/navigation.js";
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
    // A batch lands as written: the sets before a clear go in before it.
    const flush = (): void => {
      if (stored.length > 0) store.setBatch(sid, stored.splice(0));
    };
    runInAction(() => {
      for (const { key, value } of pairs)
        if (draft !== null && isHeldByEdit(key)) draft.put(key, value);
        else if (isEditModeKey(key)) unheld.put(sid, key, value);
        else if (value === null) {
          flush();
          store.clear(sid, key);
        } else stored.push({ key, value });
      flush();
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

// [LAW:no-silent-failure] THE wording for a write, or a save or cancel, meant
// for an edit that is not open: one drawn before the edit closed. A click
// fails with it, so the bar shows it; a write no click made is logged with it.
export function staleEdit(what: Iterable<string>): BadVerbArgs {
  return new BadVerbArgs(
    `edit: dropped ${[...what].join(",")} — no edit is open`,
  );
}

// Where an edit's own keys go once it ends: nowhere.
const ENDED: Unheld = { get: () => null, put: () => {} };

class EditDraft implements DraftWrites {
  // Every write this session made inside the edit, as the edit reads it,
  // from the writes of the click that opened it on.
  private readonly writes = observable.map<string, string | null>(undefined, {
    deep: false,
  });
  private pickRevision = 0;
  private readonly files = new Map<string, string | null>();
  private readonly history: SettingsHistory;
  readonly navigation: NavigationHistory;
  private latest: ConfigSnapshot | null;
  // [LAW:one-source-of-truth] Derived from `latest`, `base` and the draft's
  // files, and retaken whenever one of them changes: never assigned from
  // outside the draft.
  #revision: ConfigRevision | null = null;

  constructor(
    private readonly session: SessionId,
    private readonly base: DraftBase,
    latest: ConfigSnapshot | null,
    private readonly committed: SessionStateRW,
    sessions: SessionStateRW,
    log: DaemonLogger,
    initial: Pick<OpenDraft, "picks" | "files" | "history" | "navigation">,
    private readonly record?: (change: DraftChange) => void,
  ) {
    runInAction(() => {
      for (const [key, value] of initial.picks) this.writes.set(key, value);
    });
    for (const [file, value] of initial.files) this.files.set(file, value);
    this.latest = latest;
    this.refreshSnapshot();
    this.navigation = new NavigationHistory(
      false,
      { [session]: initial.navigation },
      record && ((edit) => record({ kind: "navigation", edit })),
    );
    // [LAW:one-type-per-behavior] The same undo step and journal serve a
    // draft, over the sessions as the router writes them, which hands this
    // session's writes to this draft. A menu's state is no setting, so
    // opening one never adds an edit step.
    this.history = new SettingsHistory(
      sessions,
      log,
      { [session]: initial.history },
      "private",
      record &&
        ((edits) => {
          for (const edit of edits) record({ kind: "history", edit });
        }),
    );
  }

  // [LAW:effects-at-boundaries] A transaction pins the content it edits.
  // The host's current layer identities and plugin discovery still decide
  // what it can load, including when the user revokes repository trust.
  get origin(): RenderOrigin {
    return this.base.origin;
  }

  updated(latest: ConfigSnapshot): void {
    if (this.latest === latest) return;
    this.latest = latest;
    this.refreshSnapshot();
  }

  // The config the draft previews: the host's latest layers, each holding
  // the draft's text for its file.
  get revision(): ConfigRevision | null {
    return this.#revision;
  }

  private refreshSnapshot(): void {
    if (this.latest === null) return;
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

  // [LAW:one-source-of-truth] Whether edit mode is open is the draft's
  // existence, so an edit with no write of its mode reads `arrange`; a write
  // of it (the click that leaves) is the request the click's consequence
  // consumes, and reads as written until then.
  read(key: string): string | null {
    if (this.writes.has(key)) return this.writes.get(key)!;
    if (key === EDIT_MODE_KEY) return EDIT_MODE_ARRANGE;
    return this.committed.get(this.session, key);
  }

  put(key: string, value: string | null): boolean {
    // [LAW:types-are-the-program] An absent override reads through to the
    // committed pick. An override holding null keeps even a later pick hidden.
    const held =
      this.committed.get(this.session, key) === value ? undefined : value;
    if (!installOverride(this.writes, key, held)) return false;
    this.record?.({
      kind: "pick",
      key,
      ...(held !== undefined && { value: held }),
    });
    this.pickRevision++;
    return true;
  }

  // Applying an accepted patch only installs state. It cannot run a click,
  // append another undo step or issue another draft proposal.
  observe(
    changes: readonly DraftChange[],
    accepted: OpenDraft,
  ): { moved: boolean; files: boolean } {
    let moved = false,
      files = false;
    for (const change of changes) {
      if (change.kind === "history") {
        this.history.observe(this.session, accepted.history);
      } else if (change.kind === "navigation") {
        this.navigation.observe(this.session, accepted.navigation);
      } else {
        const held = change.kind === "pick" ? this.writes : this.files;
        if (!installOverride(held, change.key, change.value)) continue;
        moved = true;
        if (change.kind === "file") files = true;
      }
    }
    if (files) this.refreshSnapshot();
    return { moved, files };
  }

  begin(prove: ConfigFiles["prove"]): EditTurn {
    // [LAW:carrying-cost] A click stages just the layers it touches. Only
    // Save needs to enumerate all overrides that will reach the file writer.
    const working = new Map<string, string | null | undefined>();
    const layerAt = (file: string): PinnedLayer => {
      const layer = layerAtPath(this.base.chain, file);
      if (layer === undefined)
        throw new BadVerbArgs(`${file} is not a layer of this edit`);
      return layer;
    };
    const files: ConfigFiles = {
      read: (file) => {
        const held = working.has(file)
          ? working.get(file)
          : this.files.get(file);
        return held === undefined ? layerAt(file).content : contentOfText(held);
      },
      land: (file, _before, after) => {
        const held =
          after === requireLayerText(file, layerAt(file).content)
            ? undefined
            : after;
        if (this.files.get(file) === held) working.delete(file);
        else working.set(file, held);
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
        const before = this.pickRevision;
        const clicked = journal.commit().get(this.session) ?? new Map();
        if (working.size === 0)
          return { moved: before !== this.pickRevision, clicked };
        for (const [file, held] of working) {
          installOverride(this.files, file, held);
          this.record?.({
            kind: "file",
            key: file,
            ...(held !== undefined && { value: held }),
          });
        }
        this.refreshSnapshot();
        return { moved: true, clicked };
      },
      save: (committedJournal, destination, latest) => {
        // [LAW:single-enforcer] Use the same guarded change algebra as the
        // host. Disjoint edits can coexist; a conflicting address or moved
        // layer leaves the transaction open with the preview as it was.
        const rewritten = new Map<string, string | null>();
        for (const path of new Set([...this.files.keys(), ...working.keys()])) {
          const after = working.has(path)
            ? working.get(path)
            : this.files.get(path);
          if (after === undefined) continue;
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
          if (applied.kind === "incomplete")
            throw new BadVerbArgs(`save: ${path}: ${applied.reason}`);
          if (applied.kind !== "applied")
            throw new BadVerbArgs(
              `save: ${addressText(applied.at)} in the ${source.role} layer changed while editing`,
            );
          rewritten.set(path, applied.text);
        }
        // [LAW:no-ambient-temporal-coupling] A redrawn Save may name a new
        // physical target at the same logical path. The pending differences
        // still belong to the destination the edit was opened against.
        if (
          rewritten.size &&
          this.base.fileBinding !== undefined &&
          this.base.fileBinding !== latest.fileBinding
        )
          throw new BadVerbArgs(
            "save: the writable configuration files for this edit changed while editing",
          );
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

// [LAW:one-source-of-truth] The transaction is the only owner of edit mode.
// Each session's view overlays exactly its own draft; no draft is persisted.
type ModifiedDraft = Extract<DraftWrite, { kind: "modify" }>;
type PendingDraft =
  | Exclude<DraftWrite, ModifiedDraft>
  | (Omit<ModifiedDraft, "changes"> & { changes: DraftChange[] });
export class EditTransactions {
  // [LAW:one-source-of-truth] Key readers observe the open draft's identity
  // and the one override they read. Revision readers track every change.
  private readonly drafts = observable.map<SessionId, EditDraft>(undefined, {
    deep: false,
  });
  private readonly revisions = observable.map<SessionId, number>(undefined, {
    deep: false,
  });

  // [LAW:one-source-of-truth] The session's state as every reader and every
  // writer outside a click's journal sees it: its open edit's, else the
  // store's, through the one router. An edit-mode key written with no edit
  // open (a stale click's) is dropped, said.
  readonly view: SessionStateRW;
  private readonly accepted: DraftBook;
  private readonly pending: PendingDraft[] = [];

  constructor(
    readonly committed: SessionStateRW,
    private readonly log: DaemonLogger,
    readonly shared = false,
    seed: Readonly<Record<SessionId, DraftSnapshot>> = {},
    private readonly latestFor?: (
      origin: RenderOrigin,
    ) => ConfigSnapshot | null,
  ) {
    this.accepted = new DraftBook(seed);
    const routed = routedWrites(committed, (sid) => this.draftWrites(sid), {
      get: () => null,
      put: (sid, key) =>
        log("warn", `${staleEdit([key]).message} (session=${sid})`),
    });
    this.view = {
      get: routed.get,
      set: routed.set,
      setBatch: routed.setBatch,
      clear: routed.clear,
      revision: (sid) =>
        committed.revision(sid) + (this.revisions.get(sid) ?? 0),
    };
    for (const id of Object.keys(seed)) {
      const sid = id as SessionId;
      this.install(sid, this.accepted.get(sid)!, null);
    }
  }

  drain(): DraftWrite[] {
    return this.pending.splice(0);
  }

  prepare(writes: readonly DraftWrite[]): () => readonly SessionId[] {
    const apply = this.accepted.prepare(writes);
    return () => {
      apply();
      const refresh = new Set<SessionId>();
      const changes = new Map<SessionId, DraftChange[] | null>();
      for (const write of writes) {
        if (write.kind !== "modify") changes.set(write.key, null);
        else if (changes.get(write.key) !== null) {
          const prior = changes.get(write.key) ?? [];
          prior.push(...write.changes);
          changes.set(write.key, prior);
        }
      }
      for (const [sid, patch] of changes) {
        const accepted = this.accepted.get(sid);
        if (accepted === undefined) {
          if (this.draft(sid) !== null) this.update(sid, null);
          refresh.add(sid);
        } else if (patch === null) {
          this.install(
            sid,
            accepted,
            this.latestFor?.(accepted.base.origin) ?? null,
          );
          refresh.add(sid);
        } else {
          const draft = this.draft(sid);
          if (draft === null)
            throw new Error("accepted draft patch has no open edit");
          const { moved, files } = draft.observe(patch, accepted);
          if (moved) this.changed(sid);
          if (files) refresh.add(sid);
        }
      }
      return [...refresh];
    };
  }

  private install(
    sid: SessionId,
    initial: OpenDraft,
    latest: ConfigSnapshot | null,
  ): void {
    const record = this.shared
      ? (change: DraftChange) => {
          const last = this.pending.at(-1);
          if (last?.kind === "modify" && last.key === sid)
            last.changes.push(change);
          else
            this.pending.push({
              kind: "modify",
              store: "draft",
              key: sid,
              changes: [change],
            });
        }
      : undefined;
    this.update(
      sid,
      new EditDraft(
        sid,
        initial.base,
        latest,
        this.committed,
        this.view,
        this.log,
        initial,
        record,
      ),
    );
  }

  draft(sid: SessionId): EditDraft | null {
    return this.drafts.get(sid) ?? null;
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
            if (draft.put(key, value)) this.changed(sid);
          },
        };
  }

  revision(origin: RenderOrigin, sid: SessionId): ConfigRevision | null {
    const draft = this.draft(sid);
    if (draft === null || originKey(draft.origin) !== originKey(origin))
      return null;
    const latest = this.latestFor?.(origin);
    if (latest) draft.updated(latest);
    return draft.revision;
  }

  configured(origin: RenderOrigin, snapshot: ConfigSnapshot): SessionId[] {
    const key = originKey(origin);
    const refreshed: SessionId[] = [];
    for (const [sid, draft] of this.drafts) {
      if (originKey(draft.origin) !== key) continue;
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
    const proposals = this.opening(sid, origin, snapshot, first);
    this.pending.push(...proposals);
    const base =
      proposals[0]?.base ?? pinDraft(origin, { chain: snapshot.chain });
    this.install(
      sid,
      {
        base,
        picks: new Map(first),
        files: new Map(),
        history: EMPTY_HISTORY,
        navigation: EMPTY_TIMELINE,
      },
      snapshot,
    );
  }

  closing(sid: SessionId): Array<Extract<DraftWrite, { kind: "close" }>> {
    return this.shared ? [{ store: "draft", kind: "close", key: sid }] : [];
  }

  opening(
    sid: SessionId,
    origin: RenderOrigin,
    snapshot: ConfigSnapshot,
    picks: SessionWrites,
  ): Array<Extract<DraftWrite, { kind: "open" }>> {
    return this.shared
      ? [
          {
            store: "draft",
            kind: "open",
            key: sid,
            base: pinDraft(origin, snapshot),
            picks: Object.fromEntries(picks),
          },
        ]
      : [];
  }

  close(sid: SessionId): void {
    if (this.draft(sid) === null) return;
    this.pending.push(...this.closing(sid));
    this.update(sid, null);
  }

  changed(sid: SessionId): void {
    runInAction(() =>
      this.revisions.set(sid, (this.revisions.get(sid) ?? 0) + 1),
    );
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
    if (this.shared && this.draft(sid) !== null) return;
    runInAction(() => {
      this.drafts.delete(sid);
      this.revisions.delete(sid);
    });
  }

  private update(sid: SessionId, draft: EditDraft | null): void {
    runInAction(() => {
      if (draft === null) this.drafts.delete(sid);
      else this.drafts.set(sid, draft);
      this.changed(sid);
    });
  }
}
