// [LAW:types-are-the-program] A draft pins only the writable layers it
// started from. Discovery and repository trust still come from the host.
import type { RenderOrigin } from "../config-hint.js";
import { isPlainObject } from "../config/loader/validate-core.js";
import {
  isDisplayDigest,
  type DisplayDigest,
} from "../config/displayed-config.js";
import { LAYER_ROLES, layerRoleOf } from "../config/layer-role.js";
import type {
  ConfigSnapshot,
  Layer,
  LayerContent,
} from "../config/config-snapshot.js";
import { isHeldByEdit } from "../config/session-key.js";
import {
  parseSessionId,
  type SessionId,
} from "../daemon/foundations/session-id.js";
import type { Asked } from "../utils/outcome.js";
import {
  EMPTY_HISTORY,
  historyAfter,
  isHistoryEdit,
  parseSessionHistory,
  type HistoryEdit,
  type SessionHistory,
} from "./history-storage.js";
import {
  EMPTY_TIMELINE,
  navigationAfter,
  isNavigationEdit,
  parseTimeline,
  type NavigationEdit,
  type Timeline,
} from "./navigation.js";

export type PinnedLayer = Pick<Layer, "role" | "path" | "content">;
export interface DraftBase {
  readonly origin: RenderOrigin;
  readonly fileBinding?: DisplayDigest;
  readonly chain: readonly PinnedLayer[];
}
type Overrides = Readonly<Record<string, string | null>>;
export interface DraftSnapshot {
  readonly base: DraftBase;
  readonly picks: Overrides;
  readonly files: Overrides;
  readonly history: SessionHistory;
  readonly navigation: Timeline;
}

// A missing value releases the override. A present null stages absence.
export type DraftChange =
  | {
      readonly kind: "pick" | "file";
      readonly key: string;
      readonly value?: string | null;
    }
  | { readonly kind: "history"; readonly edit: HistoryEdit }
  | { readonly kind: "navigation"; readonly edit: NavigationEdit };
export type DraftWrite = {
  readonly store: "draft";
  readonly key: SessionId;
} & (
  | {
      readonly kind: "open";
      readonly base: DraftBase;
      readonly picks: Overrides;
    }
  | { readonly kind: "modify"; readonly changes: readonly DraftChange[] }
  | { readonly kind: "close" }
);

export function pinDraft(
  origin: RenderOrigin,
  { chain, fileBinding }: Pick<ConfigSnapshot, "chain" | "fileBinding">,
): DraftBase {
  return {
    origin,
    ...(fileBinding !== undefined && { fileBinding }),
    chain: chain.map(({ role, path, content }) => ({ role, path, content })),
  };
}

function isContent(raw: unknown): raw is LayerContent {
  return (
    isPlainObject(raw) &&
    (raw.kind === "absent"
      ? Object.keys(raw).length === 1
      : Object.keys(raw).length === 2 &&
        (raw.kind === "text"
          ? typeof raw.text === "string"
          : raw.kind === "unreadable" && typeof raw.error === "string"))
  );
}
function isBase(raw: unknown): raw is DraftBase {
  if (
    !isPlainObject(raw) ||
    (raw.fileBinding === undefined
      ? Object.keys(raw).length !== 2
      : Object.keys(raw).length !== 3 || !isDisplayDigest(raw.fileBinding)) ||
    !isPlainObject(raw.origin)
  )
    return false;
  const { cwd, projectDir, target } = raw.origin;
  if (
    Object.keys(raw.origin).length !== 3 ||
    typeof cwd !== "string" ||
    typeof projectDir !== "string" ||
    !isPlainObject(target) ||
    typeof target.source !== "string"
  )
    return false;
  if (
    target.source === "search"
      ? Object.keys(target).length !== 1
      : Object.keys(target).length !== 2 ||
        typeof target.path !== "string" ||
        !["argument", "argument-only", "environment", "unknown"].includes(
          target.source,
        )
  )
    return false;
  if (!Array.isArray(raw.chain) || raw.chain.length > LAYER_ROLES.length)
    return false;
  const roles = new Set<string>();
  return raw.chain.every((layer) => {
    if (
      !isPlainObject(layer) ||
      Object.keys(layer).length !== 3 ||
      typeof layer.path !== "string" ||
      !layer.path ||
      typeof layer.role !== "string" ||
      !layerRoleOf(layer.role) ||
      !isContent(layer.content) ||
      roles.has(layer.role)
    )
      return false;
    roles.add(layer.role);
    return true;
  });
}
const overrides = (raw: unknown): raw is Overrides =>
  isPlainObject(raw) &&
  Object.values(raw).every(
    (value) => value === null || typeof value === "string",
  );
function isChange(raw: unknown): raw is DraftChange {
  if (!isPlainObject(raw)) return false;
  if (raw.kind === "history")
    return Object.keys(raw).length === 2 && isHistoryEdit(raw.edit);
  if (raw.kind === "navigation")
    return Object.keys(raw).length === 2 && isNavigationEdit(raw.edit);
  return (
    (raw.kind === "file" ||
      (raw.kind === "pick" &&
        typeof raw.key === "string" &&
        isHeldByEdit(raw.key))) &&
    typeof raw.key === "string" &&
    (Object.hasOwn(raw, "value")
      ? Object.keys(raw).length === 3 &&
        (raw.value === null || typeof raw.value === "string")
      : Object.keys(raw).length === 2)
  );
}
export function isDraftWrite(raw: unknown): raw is DraftWrite {
  if (
    !isPlainObject(raw) ||
    raw.store !== "draft" ||
    !parseSessionId(raw.key).ok
  )
    return false;
  const fields = Object.keys(raw).length;
  if (raw.kind === "close") return fields === 3;
  if (raw.kind === "open")
    return (
      fields === 5 &&
      isBase(raw.base) &&
      overrides(raw.picks) &&
      Object.keys(raw.picks).every(isHeldByEdit)
    );
  return (
    raw.kind === "modify" &&
    fields === 4 &&
    Array.isArray(raw.changes) &&
    raw.changes.length > 0 &&
    raw.changes.every(isChange)
  );
}

export function parseDraft(raw: unknown): Asked<DraftSnapshot> {
  const failed = {
    kind: "failed",
    reason: "holds an invalid open draft",
  } as const;
  if (
    !isPlainObject(raw) ||
    Object.keys(raw).length !== 5 ||
    !isBase(raw.base) ||
    !overrides(raw.picks) ||
    !overrides(raw.files) ||
    !Object.keys(raw.picks).every(isHeldByEdit)
  )
    return failed;
  const { base, picks, files } = raw;
  if (
    !Object.keys(files).every((key) =>
      base.chain.some((layer) => layer.path === key),
    )
  )
    return failed;
  const history = parseSessionHistory(raw.history);
  const navigation = parseTimeline(raw.navigation, true);
  return history.kind === "ok" && navigation.kind === "ok"
    ? {
        kind: "ok",
        value: {
          base,
          picks,
          files,
          history: history.value,
          navigation: navigation.value,
        },
      }
    : failed;
}

interface HeldDraft {
  readonly base: DraftBase;
  readonly picks: Map<string, string | null>;
  readonly files: Map<string, string | null>;
  history: SessionHistory;
  navigation: Timeline;
}
export type OpenDraft = Readonly<Omit<HeldDraft, "picks" | "files">> & {
  readonly picks: ReadonlyMap<string, string | null>;
  readonly files: ReadonlyMap<string, string | null>;
};

// [LAW:single-enforcer] A peer and the host install the same three states:
// an inherited value, an explicitly absent value, or a particular string.
export function installOverride(
  into: Pick<Map<string, string | null>, "get" | "delete"> & {
    set(key: string, value: string | null): void;
  },
  key: string,
  value: string | null | undefined,
): boolean {
  if (into.get(key) === value) return false;
  if (value === undefined) into.delete(key);
  else into.set(key, value);
  return true;
}

// [LAW:single-enforcer] Host and peer resolve relative private undo and Back
// against the same accepted state. Staging touches only incoming fields and
// can refuse a batch before a guarded file write. Snapshots are for boot.
export class DraftBook {
  private readonly open = new Map<SessionId, HeldDraft>();
  constructor(seed: Readonly<Record<SessionId, DraftSnapshot>> = {}) {
    for (const [id, draft] of Object.entries(seed))
      this.open.set(id as SessionId, {
        ...draft,
        picks: new Map(Object.entries(draft.picks)),
        files: new Map(Object.entries(draft.files)),
      });
  }
  get(id: SessionId): OpenDraft | undefined {
    return this.open.get(id);
  }
  snapshot(): Readonly<Record<SessionId, DraftSnapshot>> | undefined {
    if (!this.open.size) return undefined;
    return Object.fromEntries(
      [...this.open].map(([key, draft]) => [
        key,
        {
          ...draft,
          picks: Object.fromEntries(draft.picks),
          files: Object.fromEntries(draft.files),
        },
      ]),
    );
  }
  prepare(writes: readonly DraftWrite[]): () => void {
    const staged = new Map<SessionId, HeldDraft | undefined>();
    const overrides: Array<() => void> = [];
    for (const write of writes) {
      const prior = staged.has(write.key)
        ? staged.get(write.key)
        : this.open.get(write.key);
      if (write.kind === "open") {
        if (prior) throw new Error("cannot open an already open draft");
        staged.set(write.key, {
          base: write.base,
          picks: new Map(Object.entries(write.picks)),
          files: new Map(),
          history: EMPTY_HISTORY,
          navigation: EMPTY_TIMELINE,
        });
      } else if (write.kind === "close") staged.set(write.key, undefined);
      else {
        if (!prior) throw new Error("cannot change a closed draft");
        const next = { ...prior };
        for (const change of write.changes) {
          if (change.kind === "history")
            next.history = historyAfter(next.history, change.edit);
          else if (change.kind === "navigation")
            next.navigation = navigationAfter(next.navigation, change.edit);
          else {
            if (
              change.kind === "file" &&
              !next.base.chain.some((layer) => layer.path === change.key)
            )
              throw new Error("override names a file outside the draft");
            const map = change.kind === "file" ? next.files : next.picks;
            overrides.push(() =>
              installOverride(map, change.key, change.value),
            );
          }
        }
        staged.set(write.key, next);
      }
    }
    return () => {
      for (const apply of overrides) apply();
      for (const [id, draft] of staged) {
        if (draft) this.open.set(id, draft);
        else this.open.delete(id);
      }
    };
  }
}
