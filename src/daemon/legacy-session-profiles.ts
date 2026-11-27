// [LAW:effects-at-boundaries] The only reader of the former per-renderer
// layout during cutover. Keep the original bytes, including rejected entries,
// independently of the last export an older binary could have edited.
import { readBytesIfPresent } from "../utils/regular-text.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  MAIN_RENDERER,
  parsedRendererName,
  type RendererName,
} from "./foundations/renderer-name.js";
import { profilePaths, type DaemonPaths } from "./paths.js";
import type { Found, StoreReport } from "./foundations/stored-file.js";
import { setAside } from "./file-rewrites.js";
import {
  sessionsOf,
  SESSION_STATE_FILE,
  type SessionFileKind,
  type Loaded,
} from "./session-state-file.js";
import { HISTORY_FILE } from "./history-file.js";
import { publishByLink, asError, writeAtomic } from "../utils/atomic-write.js";
import { ownValue } from "../utils/plain.js";
import { type StoredState } from "../renderer-interface/stored-state.js";
import type { Asked } from "../utils/outcome.js";
import type { SessionId } from "./foundations/session-id.js";
import { reconcileSessionProfile } from "./reconcile-session-profile.js";

type Paths = Pick<DaemonPaths, "state" | "sessionState" | "settingsHistory">;
type Store = keyof StoredState;
export type ProfileFiles = Readonly<Record<Store, string | null>>;
export type ProfileBasis = Readonly<Record<RendererName, ProfileFiles>>;
const ABSENT: ProfileFiles = { sessions: null, history: null };
const STORES = ["sessions", "history"] as const;

const idOf = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

// [LAW:no-silent-failure] The file's ordinary parser judges every entry.
// JSON engine diagnostics sometimes quote private input, so only the format
// error and the recovery location appear in the report.
function parseBytes<V>(
  bytes: Buffer,
  spec: Pick<SessionFileKind<V>, "parse">,
): Asked<Loaded<V>> {
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { kind: "failed", reason: "is not JSON" };
  }
  return sessionsOf(spec)(doc);
}

export class LegacySessionProfiles {
  constructor(
    private readonly paths: Paths,
    readonly archive: string,
  ) {}

  private file(name: RendererName, store: Store): string {
    const paths = profilePaths(this.paths, name);
    return store === "sessions" ? paths.sessionState : paths.settingsHistory;
  }

  // A new name needs a v24 handoff even if the host dies before exporting.
  // Its old directory already represents that membership through a restart.
  register(name: RendererName): void {
    if (name !== MAIN_RENDERER)
      fs.mkdirSync(path.dirname(this.file(name, "sessions")), {
        recursive: true,
        mode: 0o700,
      });
  }

  names(basis: ProfileBasis): RendererName[] {
    const names = new Set<RendererName>(
      Object.keys(basis).map((name) => {
        const parsed = parsedRendererName(name);
        if (parsed === null)
          throw new Error("invalid renderer name in session checkpoint");
        return parsed;
      }),
    );
    const dir = path.join(this.paths.state, "renderers");
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      entries = [];
    }
    for (const entry of entries) {
      const name = parsedRendererName(entry.name);
      if (name !== null && (entry.isDirectory() || entry.isSymbolicLink()))
        names.add(name);
    }
    names.delete(MAIN_RENDERER);
    return [MAIN_RENDERER, ...[...names].sort()];
  }

  // The digest names the exact contents, including whitespace, invalid UTF-8
  // and key order. Never replace an earlier recovery object with new bytes.
  preserve(bytes: Buffer): string {
    const id = idOf(bytes);
    const file = path.join(this.archive, id);
    const existing = readBytesIfPresent(file);
    if (existing === null) {
      fs.mkdirSync(this.archive, { recursive: true, mode: 0o700 });
      const result = publishByLink(file, bytes, 0o600);
      if (result.leftover !== null) throw new Error(result.leftover);
      if (result.outcome === "published") return id;
    }
    if (!(existing ?? this.archived(id)).equals(bytes))
      throw new Error(
        `session recovery object ${file} differs from its digest`,
      );
    return id;
  }

  private archived(id: string): Buffer {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new Error("invalid session recovery object name");
    const file = path.join(this.archive, id);
    const bytes = readBytesIfPresent(file);
    if (bytes === null)
      throw new Error(`missing session recovery object ${file}`);
    if (idOf(bytes) !== id)
      throw new Error(
        `session recovery object ${file} differs from its digest`,
      );
    return bytes;
  }

  private prior<V>(
    id: string | null,
    spec: Pick<SessionFileKind<V>, "parse">,
  ): Readonly<Record<SessionId, V>> {
    if (id === null) return {};
    const parsed = parseBytes(this.archived(id), spec);
    if (parsed.kind !== "ok")
      throw new Error(
        `cannot reconstruct session export ${id}: ${parsed.reason}`,
      );
    return Object.fromEntries(parsed.value.sessions);
  }

  private read<V>(
    file: string,
    spec: Pick<SessionFileKind<V>, "parse">,
  ): {
    raw: string | null;
    value: Readonly<Record<SessionId, V>>;
    found: Found;
  } {
    let bytes: Buffer | null = null;
    let reason: string | undefined;
    try {
      bytes = readBytesIfPresent(file);
    } catch (error) {
      reason = asError(error).message;
    }
    const raw = bytes === null ? null : this.preserve(bytes);
    if (bytes !== null) {
      const parsed = parseBytes(bytes, spec);
      if (parsed.kind === "ok")
        return {
          raw,
          value: Object.fromEntries(parsed.value.sessions),
          found: {
            kind: "read",
            sessions: parsed.value.sessions.size,
            dropped: parsed.value.dropped,
          },
        };
      reason = `${file} ${parsed.reason}`;
    }
    if (reason === undefined)
      return { raw, value: {}, found: { kind: "absent" } };
    try {
      return {
        raw,
        value: {},
        found: { kind: "set-aside", reason, to: setAside(file).to },
      };
    } catch (error) {
      return {
        raw,
        value: {},
        found: { kind: "refused", reason, error: asError(error).message },
      };
    }
  }

  reconcile(recovered: StoredState, basis: ProfileBasis, revision: number) {
    const reports: StoreReport[] = [];
    const next = new Map<RendererName, ProfileFiles>();
    const observed = new Map<RendererName, ProfileFiles>();
    const refused = new Set<string>();
    const conflicts = [];
    const sourcesFor = {
      sessions: new Map<string, string[]>(),
      history: new Map<string, string[]>(),
    };
    let state = recovered;
    for (const name of this.names(basis)) {
      const before = ownValue(basis, name) ?? ABSENT;
      const picks = this.read(this.file(name, "sessions"), SESSION_STATE_FILE);
      const history = this.read(this.file(name, "history"), HISTORY_FILE);
      const reads = { sessions: picks, history };
      const usable = (found: Found) =>
        found.kind === "read" || found.kind === "absent";
      const changedPicks = usable(picks.found) && picks.raw !== before.sessions;
      const changedHistory =
        usable(history.found) && history.raw !== before.history;
      if (changedPicks || changedHistory) {
        const previous = {
          sessions: changedPicks
            ? this.prior(before.sessions, SESSION_STATE_FILE)
            : {},
          history: changedHistory
            ? this.prior(before.history, HISTORY_FILE)
            : {},
        };
        const incoming = {
          sessions: changedPicks ? picks.value : {},
          history: changedHistory ? history.value : {},
        };
        const result = reconcileSessionProfile(previous, state, incoming);
        state = result.state;
        for (const conflict of result.conflicts) {
          conflicts.push({
            ...conflict,
            name,
            priorFiles: [
              ...(sourcesFor[conflict.store].get(conflict.session) ?? []),
            ],
          });
        }
        for (const store of STORES)
          for (const id of new Set([
            ...Object.keys(previous[store]),
            ...Object.keys(incoming[store]),
          ])) {
            const sources = sourcesFor[store].get(id) ?? [];
            sources.push(this.file(name, store));
            sourcesFor[store].set(id, sources);
          }
      }
      next.set(name, {
        sessions: usable(picks.found)
          ? picks.raw
          : picks.found.kind === "refused"
            ? before.sessions
            : null,
        history: usable(history.found)
          ? history.raw
          : history.found.kind === "refused"
            ? before.history
            : null,
      });
      observed.set(name, { sessions: picks.raw, history: history.raw });
      for (const store of STORES) {
        const { found } = reads[store];
        const file = this.file(name, store);
        if (found.kind === "refused") refused.add(file);
        reports.push({
          store: store === "sessions" ? "Session picks" : "Settings history",
          file,
          found,
        });
      }
    }
    const sources = Object.fromEntries(observed);
    const nextBasis = Object.fromEntries(next);
    // The immutable manifest maps each conflicting or omitted original to
    // its source name and includes the host state before reconciliation.
    const changed = JSON.stringify(nextBasis) !== JSON.stringify(basis);
    if (
      (changed &&
        [...observed.values()].some(
          (p) => p.sessions !== null || p.history !== null,
        )) ||
      conflicts.length
    ) {
      const recovery = this.preserve(
        Buffer.from(
          JSON.stringify({ version: 1, revision, basis, sources, recovered }),
        ),
      );
      for (const { name, session, store, priorFiles } of conflicts) {
        const file = this.file(name, store);
        reports.push({
          store: "Session migration",
          file,
          found: {
            kind: "reconciled",
            message: `session ${JSON.stringify(session)} conflicts with the host at revision ${revision}${priorFiles.length ? " and prior profile inputs " + priorFiles.join(", ") : ""}. Recover the original files and host state from ${path.join(this.archive, recovery)}`,
          },
        });
      }
      return { state, basis: nextBasis, reports, refused, recovery };
    }
    return { state, basis: nextBasis, reports, refused, recovery: null };
  }

  // Publish the exact same bytes that form the next downgrade comparison.
  // Preserve empty or missing legacy files when their contents already agree.
  planExport(
    state: StoredState,
    names: Iterable<RendererName>,
    basis: ProfileBasis,
    refused: ReadonlySet<string>,
  ): ProfileBasis {
    const result = new Map<RendererName, ProfileFiles>();
    const contents = new Map<Store, string>();
    for (const name of names) {
      const files = { ...(ownValue(basis, name) ?? ABSENT) };
      for (const store of STORES) {
        const file = this.file(name, store);
        if (refused.has(file)) continue;
        if (files[store] === null && Object.keys(state[store]).length === 0)
          continue;
        let id = contents.get(store);
        if (id === undefined) {
          id = this.preserve(Buffer.from(JSON.stringify(state[store])));
          contents.set(store, id);
        }
        files[store] = id;
      }
      result.set(name, files);
    }
    return Object.fromEntries(result);
  }
  publishExport(basis: ProfileBasis, target: ProfileBasis): void {
    for (const name of Object.keys(target) as RendererName[]) {
      const before = ownValue(basis, name) ?? ABSENT;
      for (const store of STORES) {
        const id = target[name]![store];
        if (id !== null && id !== before[store])
          writeAtomic(
            this.file(name, store),
            this.archived(id).toString("utf8"),
            0o600,
          );
      }
    }
  }

  // The journal checkpoint publishes the intended handoff before the first
  // legacy rename. A file already published uses those bytes as its basis.
  // Unrecognizable bytes during an interrupted handoff retain all possible
  // predecessors and are reported before their edits are reconciled.
  interrupted(
    basis: ProfileBasis,
    target: ProfileBasis,
  ): { basis: ProfileBasis; reports: StoreReport[] } {
    const result = new Map<RendererName, ProfileFiles>();
    const reports: StoreReport[] = [];
    for (const name of Object.keys(target) as RendererName[]) {
      const files = { ...(ownValue(basis, name) ?? ABSENT) };
      for (const store of STORES) {
        const desired = target[name]![store];
        if (files[store] === desired) continue;
        const file = this.file(name, store);
        const bytes = readBytesIfPresent(file);
        const actual = bytes === null ? null : idOf(bytes);
        if (actual === desired) files[store] = desired;
        else if (actual !== files[store]) {
          const kept = this.preserve(
            Buffer.from(
              JSON.stringify({
                version: 1,
                file,
                prior: files[store],
                intended: desired,
                observed: bytes === null ? null : this.preserve(bytes),
              }),
            ),
          );
          reports.push({
            store: "Interrupted session export",
            file,
            found: {
              kind: "reconciled",
              message: `Edited across an interrupted export. Both possible bases and the observed file are kept in ${path.join(this.archive, kept)}`,
            },
          });
        }
      }
      result.set(name, files);
    }
    return { basis: Object.fromEntries(result), reports };
  }
}
