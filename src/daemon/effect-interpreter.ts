// [LAW:single-enforcer] Where a config write lands: the host applies a turn's
// `change`s to their files as the files stand, keeping every byte a change
// does not touch, and lands them together or not at all, with the answers its
// click gave the trust book: an approval is what decides which config a
// session renders, so it lands with the configs or not at all. Every read in
// every file is checked before any file is written, and a write that fails
// puts back the files already written. No renderer writes a config file, or
// Claude Code's settings.

import {
  writeRevisions,
  type FileRewrite,
  type FileRetirement,
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
import type { RenderOrigin } from "../config-hint.js";
import { answeredBook } from "./config-discovery/repo-configs.js";
import type { RendererConfigs } from "./config-discovery/config-discovery.js";
import { gitRootOf, sharedExcludeOf } from "../utils/git-root.js";
import { ABSENT, ok, type Outcome } from "../utils/outcome.js";
import path from "node:path";
import { asError, resolvedTarget } from "../utils/atomic-write.js";

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
  | Extract<EffectOutcome, { kind: "refused" | "failed" | "closing" }>;

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

const originText = (origin: RenderOrigin): string =>
  `projectDir=${origin.projectDir} cwd=${origin.cwd} configFile=${origin.target.path ?? "-"}`;

// [LAW:no-silent-failure] Every way the turn's changes did not land is their
// one outcome, naming the file, and the setting when one moved.
export function performChanges(
  changes: readonly ConfigChange[],
  book: TrustBook | null,
  files: ConfigWriteFiles,
): ConfigLanding {
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
      if (target.role === "local") local.add(file);
      // A file an earlier change of the turn named, as that change left it,
      // an absent one included.
      const prior = rewrites.get(file);
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
      rewrites.set(file, { file, was, will: applied.text });
    }
    // [LAW:single-enforcer] A local layer a change creates is one person's,
    // so git never shows it: its repository's shared exclude names it, in the
    // same write as the file, or neither is written.
    for (const { file, was, will } of [...rewrites.values()]) {
      if (was !== null || will === null || !local.has(file)) continue;
      const excluded = excludeRewrite(file, rewrites, files.readText);
      if (excluded.kind === "failed")
        return {
          kind: "failed",
          reason: `${file} could not be kept out of git: ${excluded.reason} — nothing was written`,
        };
      if (excluded.kind === "ok")
        rewrites.set(excluded.value.file, excluded.value);
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
        rewrites.set(file, { ...rewrite, file });
      }
    }
  } catch (e) {
    return {
      kind: "failed",
      reason: `config read failed: ${asError(e).message}`,
    };
  }
  let landed: readonly string[];
  try {
    landed = writeRevisions(rewrites.values(), retire);
  } catch (e) {
    return {
      kind: "failed",
      reason: `config write failed: ${asError(e).message}`,
    };
  }
  for (const line of answered) book?.said(line);
  return { kind: "ok", files: landed };
}

// The rewrite of the exclude file of `file`'s repository that names it, or
// absent when it is in no checkout or already named.
function excludeRewrite(
  file: string,
  rewrites: ReadonlyMap<string, FileRewrite>,
  readText: ConfigWriteFiles["readText"],
): Outcome<FileRewrite> {
  const checkout = gitRootOf(path.dirname(file));
  if (checkout.kind !== "ok") return checkout;
  const root = checkout.value;
  const at = sharedExcludeOf(root);
  if (at.kind !== "ok") return at;
  const exclude = resolvedTarget(at.value);
  const prior = rewrites.get(exclude);
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
  return ok({ file: exclude, was, will: `${text}${lead}${entry}\n` });
}
