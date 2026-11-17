// [LAW:single-enforcer] Where a config write lands: the host applies a turn's
// `change`s to their files as the files stand, keeping every byte a change
// does not touch, and lands them together or not at all, with the answers its
// click gave the trust book: an approval is what decides which config a
// session renders, so it lands with the configs or not at all. Every read in
// every file is checked before any file is written, and a write that fails
// puts back the files already written. No renderer writes a config file, or
// Claude Code's settings.

import fs from "node:fs";
import {
  addressText,
  applyChanges,
  type Read,
} from "../config/config-changes.js";
import { JSON5_DIALECT, JSON_DIALECT } from "../config/json5-edit.js";
import type { SessionId } from "./foundations/session-id.js";
import type { LayerRole } from "../config/layer-role.js";
import type {
  Act,
  ConfigChange,
  EffectOutcome,
} from "../renderer-interface/interface.js";
import { answeredBook } from "./config-discovery/repo-configs.js";
import { gitRootOf, sharedExcludeOf } from "../utils/git-root.js";
import { ABSENT, ok, type Outcome } from "../utils/outcome.js";
import path from "node:path";
import {
  readConfigText,
  resolvedTarget,
  writeAtomic,
} from "../utils/atomic-write.js";

const writeText = (file: string, text: string | null): void =>
  text === null
    ? fs.rmSync(resolvedTarget(file), { force: true })
    : writeAtomic(file, text);

const said = (read: Read | "object"): string =>
  read === "object"
    ? "an object"
    : read.kind === "absent"
      ? "nothing"
      : read.kind === "file"
        ? "the file as it was read"
        : read.text;

// A file as it stood, and as the turn's changes leave it.
interface Rewrite {
  readonly file: string;
  readonly was: string | null;
  readonly will: string | null;
}

export type ApproveRepo = Extract<Act, { kind: "approve-repo" }>;

// The trust book a turn's answers land in, and where what each did is said
// once they have.
export interface TrustBook {
  readonly stateDir: string;
  readonly answers: readonly ApproveRepo[];
  readonly said: (line: string) => void;
}

// [LAW:single-enforcer] What a turn's changes are resolved against: each
// session's snapshot as the host's discovery holds it, so a renderer names a
// layer by its role, and a repository by the question its bar was asked.
export interface SessionLayers {
  // The file the session's layer of `role` lives at, or null when its chain
  // has no such layer.
  readonly path: (session: SessionId, role: LayerRole) => string | null;
  // The directory the session's repository question is answered under, or
  // null when it has none.
  readonly repoDir: (session: SessionId) => string | null;
}

// The Claude Code settings files a session's doctor reading handed in, which
// a `claude-settings` change may write (`writableSettingsFiles`); none while
// it holds no reading.
export type WritableSettings = (session: SessionId) => readonly string[];

// [LAW:no-silent-failure] Every way the turn's changes did not land is their
// one outcome, naming the file, and the setting when one moved.
export function performChanges(
  changes: readonly ConfigChange[],
  book: TrustBook | null,
  writable: WritableSettings,
  layers: SessionLayers,
): EffectOutcome {
  const rewrites = new Map<string, Rewrite>();
  // The files a change to a local layer lands in.
  const local = new Set<string>();
  let answered: readonly string[] = [];
  try {
    for (const { session, target, changes: list } of changes) {
      const named =
        target.kind === "layer"
          ? layers.path(session, target.role)
          : target.file;
      if (named === null)
        return {
          kind: "refused",
          reason: `the session's config has no ${target.kind === "layer" ? target.role : ""} layer — nothing was written`,
        };
      // Keyed by the file a write lands in, so two paths to one file are one
      // rewrite of it.
      const file = resolvedTarget(named);
      if (target.kind === "layer" && target.role === "local") local.add(file);
      // [LAW:single-enforcer] A renderer names a settings file only among
      // those the host's own reading handed it.
      if (
        target.kind === "claude-settings" &&
        !writable(session).some((f) => resolvedTarget(f) === file)
      )
        return {
          kind: "refused",
          reason: `${file} is not a settings file the session's doctor read — nothing was written`,
        };
      // A file an earlier change of the turn named, as that change left it,
      // an absent one included.
      const prior = rewrites.get(file);
      const was = prior === undefined ? readConfigText(file) : prior.was;
      // Claude Code parses its settings as strict JSON.
      const applied = applyChanges(
        prior === undefined ? was : prior.will,
        list,
        target.kind === "layer" ? JSON5_DIALECT : JSON_DIALECT,
      );
      if (applied.kind === "moved")
        return {
          kind: "refused",
          reason: `${addressText(applied.at)} in ${file} changed since it was read (it was ${said(applied.read)}, it is ${said(applied.found)}) — nothing was written`,
        };
      rewrites.set(file, { file, was, will: applied.text });
    }
    // [LAW:single-enforcer] A local layer a change creates is one person's,
    // so git never shows it: its repository's shared exclude names it, in the
    // same write as the file, or neither is written.
    for (const { file, was, will } of [...rewrites.values()]) {
      if (was !== null || will === null || !local.has(file)) continue;
      const excluded = excludeRewrite(file, rewrites);
      if (excluded.kind === "failed")
        return {
          kind: "failed",
          reason: `${file} could not be kept out of git: ${excluded.reason} — nothing was written`,
        };
      if (excluded.kind === "ok")
        rewrites.set(excluded.value.file, excluded.value);
    }
    // [LAW:single-enforcer] An answer is recorded only for the repository its
    // session's bar asked about: a signed link to another directory, or one
    // drawn before the session moved, is refused.
    const strayAnswer = book?.answers.find(
      ({ session, dir }) => layers.repoDir(session) !== dir,
    );
    if (strayAnswer !== undefined)
      return {
        kind: "refused",
        reason: `${strayAnswer.dir} is not the repository the session's config asks about — nothing was written`,
      };
    if (book !== null && book.answers.length > 0) {
      const planned = answeredBook(book.stateDir, book.answers);
      if (planned.kind === "failed")
        return {
          kind: "failed",
          reason: `the repository answers were not recorded: ${planned.reason} — nothing was written`,
        };
      const { file, text } = planned.value;
      answered = planned.value.said;
      if (text !== null) {
        const at = resolvedTarget(file);
        rewrites.set(at, { file: at, was: readConfigText(at), will: text });
      }
    }
  } catch (e) {
    return { kind: "failed", reason: `config read failed: ${message(e)}` };
  }
  const written: Rewrite[] = [];
  try {
    for (const rewrite of rewrites.values()) {
      writeText(rewrite.file, rewrite.will);
      written.push(rewrite);
    }
    for (const line of answered) book!.said(line);
    return { kind: "ok" };
  } catch (e) {
    return { kind: "failed", reason: putBack(written, e) };
  }
}

// The rewrite of the exclude file of `file`'s repository that names it, or
// absent when it is in no checkout or already named.
function excludeRewrite(
  file: string,
  rewrites: ReadonlyMap<string, Rewrite>,
): Outcome<Rewrite> {
  const root = gitRootOf(path.dirname(file));
  if (root === undefined) return ABSENT;
  const at = sharedExcludeOf(root);
  if (at.kind !== "ok") return at.kind === "absent" ? ABSENT : at;
  const exclude = resolvedTarget(at.value);
  const prior = rewrites.get(exclude);
  const was = prior === undefined ? readConfigText(exclude) : prior.was;
  const text = prior === undefined ? (was ?? "") : (prior.will ?? "");
  // The path as a gitignore pattern names it: glob characters in a directory
  // name are escaped, so the entry matches this file and only it.
  const entry = `/${path
    .relative(root, file)
    .split(path.sep)
    .join("/")
    .replace(/[\\*?[]/g, "\\$&")}`;
  // A line is an entry by its text, as git reads it: a CRLF file's `\r` and
  // trailing spaces are not part of the pattern.
  if (text.split("\n").some((line) => line.trimEnd() === entry)) return ABSENT;
  const lead = text === "" || text.endsWith("\n") ? "" : "\n";
  return ok({ file: exclude, was, will: `${text}${lead}${entry}\n` });
}

// The files a failed write already wrote, put back as they stood.
function putBack(written: readonly Rewrite[], cause: unknown): string {
  const reason = `config write failed: ${message(cause)}`;
  try {
    for (const { file, was } of [...written].reverse()) writeText(file, was);
    return `${reason} — nothing was written`;
  } catch (e) {
    return `${reason}; and putting back what was written failed, so it is half-written: ${message(e)}`;
  }
}

const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
