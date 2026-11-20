// [LAW:single-enforcer] Where a config write lands: the host applies a turn's
// `change`s to their files as the files stand, keeping every byte a change
// does not touch, and batches them with the answers its click gave the trust
// book. Every read is checked before publication. If a publication fails,
// any earlier write whose restoration failed is sent to shared discovery.

import {
  writeRevisions,
  type FileRewrite,
  type FileRetirement,
  type WriteConfigFile,
} from "./file-rewrites.js";
import {
  addressText,
  applyChanges,
  type Read,
} from "../config/config-changes.js";
import { JSON5_DIALECT } from "../config/json5-edit.js";
import type {
  Act,
  ChangeTarget,
  ConfigChange,
  EffectOutcome,
} from "../renderer-interface/interface.js";
import { originText } from "../config-hint.js";
import { answeredBook } from "./config-discovery/repo-configs.js";
import type { RendererConfigs } from "./config-discovery/config-discovery.js";
import { gitRootOf, sharedExcludeOf } from "../utils/git-root.js";
import { ABSENT, ok, type Outcome } from "../utils/outcome.js";
import path from "node:path";
import { asError, resolvedTarget } from "../utils/atomic-write.js";
import { directoryEntries } from "../utils/directory-entry.js";

const said = (read: Read | "object"): string =>
  read === "object"
    ? "an object"
    : read.kind === "absent"
      ? "nothing"
      : read.kind === "file"
        ? "the file as it was read"
        : read.text;

export type ApproveRepo = Extract<Act, { kind: "approve-repo" }>;

// The trust book a turn's answers land in, and where what each did is said
// once they have.
export interface TrustBook {
  readonly stateDir: string;
  readonly answers: readonly ApproveRepo[];
  readonly said: (line: string) => void;
}

// [LAW:single-enforcer] Where a change naming an origin's layer lands, and
// which repository an answer may be given for: config discovery's, so a
// renderer names a role and never a path.
export type ConfigWriteFiles = Pick<
  RendererConfigs,
  "path" | "repoDir" | "readText"
>;

export type ConfigLanding =
  | { readonly kind: "ok"; readonly files: readonly string[] }
  | {
      readonly kind: "incomplete";
      readonly files: readonly string[];
      readonly reason: string;
    }
  | Extract<EffectOutcome, { kind: "refused" | "failed" | "closing" }>;

// [LAW:effects-at-boundaries] Only the host uses the affected paths to
// observe disk. The renderer receives its ordinary effect verdict.
export function configEffectOutcome(landed: ConfigLanding): EffectOutcome {
  if (landed.kind === "ok") return { kind: "ok" };
  if (landed.kind === "incomplete")
    return { kind: "failed", reason: landed.reason };
  return landed;
}

const refused = (reason: string): ConfigLanding => ({
  kind: "refused",
  reason: `${reason} — nothing was written`,
});

// The file a change's target names, or why it names none.
function landsIn(
  target: ChangeTarget,
  files: ConfigWriteFiles,
):
  | { readonly kind: "at"; readonly file: string }
  | { readonly kind: "refused"; readonly reason: string } {
  const file = files.path(target.origin, target.role);
  if (file === undefined)
    return {
      kind: "refused",
      reason: `a change names an origin config discovery does not follow (${originText(target.origin)})`,
    };
  if (file === null)
    return {
      kind: "refused",
      reason: `a change names the ${target.role} layer, and its origin's chain holds none (${originText(target.origin)})`,
    };
  return { kind: "at", file };
}

// [LAW:no-silent-failure] Every way the turn's changes did not land is their
// one outcome, naming the file, and the setting when one moved.
export function performChanges(
  changes: readonly ConfigChange[],
  book: TrustBook | null,
  files: ConfigWriteFiles,
  write?: WriteConfigFile,
): ConfigLanding {
  const entryOf = directoryEntries();
  const rewrites = new Map<string, FileRewrite>();
  // The files a local layer's change lands in: the ones git never shows.
  const local = new Set<string>();
  let retire: FileRetirement | null = null;
  let answered: readonly string[] = [];
  // [LAW:no-silent-failure] An answer is for the repository its origin asks
  // about as discovery last found it, or none is recorded.
  for (const { origin, dir } of book?.answers ?? []) {
    const asked = files.repoDir(origin);
    if (asked === undefined)
      return refused(
        `the answer for ${dir} names an origin config discovery does not follow (${originText(origin)})`,
      );
    if (asked !== dir)
      return refused(
        `the answer for ${dir} is not for the repository its origin asks about (${asked ?? "none"})`,
      );
  }
  try {
    for (const { target, changes: list } of changes) {
      const named = landsIn(target, files);
      if (named.kind === "refused") return refused(named.reason);
      // Keyed by the file a write lands in, so two paths to one file are one
      // rewrite of it.
      const file = resolvedTarget(named.file);
      const entry = entryOf(file);
      if (target.role === "local") local.add(entry);
      // A file an earlier change of the turn named, as that change left it,
      // an absent one included.
      const prior = rewrites.get(entry);
      const was = prior === undefined ? files.readText(file) : prior.was;
      const applied = applyChanges(
        prior === undefined ? was : prior.will,
        list,
        JSON5_DIALECT,
      );
      if (applied.kind === "moved")
        return refused(
          `${addressText(applied.at)} in ${file} changed since it was read (it was ${said(applied.read)}, it is ${said(applied.found)})`,
        );
      rewrites.set(entry, {
        file: prior?.file ?? file,
        was,
        will: applied.text,
      });
    }
    // [LAW:single-enforcer] A local layer a change creates is one person's,
    // so git never shows it: its repository's shared exclude names it, in the
    // same write as the file, or neither is written.
    for (const [entry, { file, was, will }] of [...rewrites]) {
      if (was !== null || will === null || !local.has(entry)) continue;
      const excluded = excludeRewrite(entry, rewrites, files.readText, entryOf);
      if (excluded.kind === "failed")
        return {
          kind: "failed",
          reason: `${file} could not be kept out of git: ${excluded.reason} — nothing was written`,
        };
      if (excluded.kind === "ok")
        rewrites.set(entryOf(excluded.value.file), excluded.value);
    }
    if (book !== null && book.answers.length > 0) {
      const planned = answeredBook(book.stateDir, book.answers, files.readText);
      if (planned.kind === "failed")
        return {
          kind: "failed",
          reason: `the repository answers were not recorded: ${planned.reason} — nothing was written`,
        };
      const { rewrite } = planned.value;
      retire = planned.value.retire;
      answered = planned.value.said;
      if (rewrite !== null) {
        const file = resolvedTarget(rewrite.file);
        rewrites.set(entryOf(file), { ...rewrite, file });
      }
    }
  } catch (e) {
    return {
      kind: "failed",
      reason: `config read failed: ${asError(e).message}`,
    };
  }
  const landed = writeRevisions(rewrites.values(), retire, write);
  if (landed.kind === "failed") {
    return {
      kind: "failed",
      reason: `config write failed: ${landed.error.message} — no file changes kept`,
    };
  }
  if (landed.kind === "incomplete") {
    return {
      kind: "incomplete",
      files: landed.unrestored.map(({ file }) => file),
      reason: [
        `config write failed: ${landed.error.message}`,
        ...landed.unrestored.map(
          ({ file, error }) => `could not restore ${file}: ${error.message}`,
        ),
      ].join("\n"),
    };
  }
  for (const line of answered) book?.said(line);
  return landed;
}

// The rewrite of the exclude file of `file`'s repository that names it, or
// absent when it is in no checkout or already named.
function excludeRewrite(
  file: string,
  rewrites: ReadonlyMap<string, FileRewrite>,
  readText: ConfigWriteFiles["readText"],
  entryOf: (file: string) => string,
): Outcome<FileRewrite> {
  const checkout = gitRootOf(path.dirname(file));
  if (checkout.kind !== "ok") return checkout;
  const root = checkout.value;
  const at = sharedExcludeOf(root);
  if (at.kind !== "ok") return at;
  const exclude = resolvedTarget(at.value);
  const prior = rewrites.get(entryOf(exclude));
  const was = prior === undefined ? readText(exclude) : prior.was;
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
  return ok({
    file: prior?.file ?? exclude,
    was,
    will: `${text}${lead}${entry}\n`,
  });
}
