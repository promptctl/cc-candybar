// [LAW:single-enforcer] Where a config write lands: the host applies a turn's
// `change`s to their files as the files stand, keeping every byte a change
// does not touch, and lands them together or not at all, with the answers its
// click gave the trust book: an approval is what decides which config a
// session renders, so it lands with the configs or not at all. Every read in
// every file is checked before any file is written, and a write that fails
// puts back the files already written. No renderer writes a config file.

import fs from "node:fs";
import {
  addressText,
  applyChanges,
  type Read,
} from "../config/config-changes.js";
import type {
  Act,
  ConfigChange,
  EffectOutcome,
} from "../renderer-interface/interface.js";
import { answeredBook } from "../config/repo-configs.js";
import { isLocalConfigFile } from "../config/loader/discovery.js";
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

// [LAW:no-silent-failure] Every way the turn's changes did not land is their
// one outcome, naming the file, and the setting when one moved.
export function performChanges(
  changes: readonly ConfigChange[],
  book: TrustBook | null,
): EffectOutcome {
  const rewrites = new Map<string, Rewrite>();
  let answered: readonly string[] = [];
  try {
    for (const { target, changes: list } of changes) {
      // Keyed by the file a write lands in, so two paths to one file are one
      // rewrite of it.
      const file = resolvedTarget(target.path);
      // A file an earlier change of the turn named, as that change left it,
      // an absent one included.
      const prior = rewrites.get(file);
      const was = prior === undefined ? readConfigText(file) : prior.was;
      const applied = applyChanges(
        prior === undefined ? was : prior.will,
        list,
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
      if (was !== null || will === null || !isLocalConfigFile(file)) continue;
      const excluded = excludeRewrite(file, rewrites);
      if (excluded.kind === "failed")
        return {
          kind: "failed",
          reason: `${file} could not be kept out of git: ${excluded.reason} — nothing was written`,
        };
      if (excluded.kind === "ok")
        rewrites.set(excluded.value.file, excluded.value);
    }
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
  const entry = `/${path.relative(root, file).split(path.sep).join("/")}`;
  if (text.split("\n").includes(entry)) return ABSENT;
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
