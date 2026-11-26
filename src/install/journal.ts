import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { asError } from "../utils/atomic-write.js";
import { readRegularTextSync } from "../utils/regular-text.js";

// [LAW:no-ambient-temporal-coupling] Write each intent before its filesystem
// operation. A later installer holding the same home claim can finish a
// rollback even if the previous process died between two directory renames.
type Entry =
  | { readonly op: "mkdir" | "stage"; readonly file: string }
  | { readonly op: "remove"; readonly file: string; readonly old: string }
  | {
      readonly op: "replace";
      readonly file: string;
      readonly stage: string;
      readonly old: string | null;
      readonly original: string | null;
      readonly installed: string;
      readonly contents: string;
    }
  | { readonly op: "commit" };

type Pending = Exclude<Entry, { op: "commit" }>;

export function fileIdentity(file: string): string | null {
  const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  return stat === undefined ? null : `${stat.dev}:${stat.ino}`;
}

// A directory's own timestamps do not change when a program edits a file
// nested inside it. Identify the replacement's entire tree before removing
// it on rollback. A renamed, byte-identical third-party file is also spared
// by the root inode check.
export function contentsOf(file: string): string {
  const hash = createHash("sha256");
  function visit(at: string): void {
    const stat = fs.lstatSync(at);
    hash.update(
      JSON.stringify([path.relative(file, at), stat.mode, stat.size]),
    );
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(at).sort()) visit(path.join(at, name));
    } else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(at));
    else if (stat.isFile()) hash.update(fs.readFileSync(at));
    else throw new Error(`unexpected file type in staged tree: ${at}`);
  }
  visit(file);
  return hash.digest("hex");
}

const tempName = /\.\d+\.[a-f0-9]+\.tmp$/;
const absolute = (v: unknown): v is string =>
  typeof v === "string" && path.isAbsolute(v);
const temp = (v: unknown): v is string => absolute(v) && tempName.test(v);
const beside = (v: unknown, file: string): v is string =>
  temp(v) && v.startsWith(file + ".") && path.dirname(v) === path.dirname(file);
const identity = (v: unknown) => typeof v === "string" && /^\d+:\d+$/.test(v);

function entryOf(raw: unknown): Entry {
  if (raw !== null && typeof raw === "object" && "op" in raw) {
    if (raw.op === "commit") return { op: "commit" };
    if ("file" in raw && absolute(raw.file)) {
      if (raw.op === "mkdir") return { op: "mkdir", file: raw.file };
      if (raw.op === "stage" && temp(raw.file))
        return { op: "stage", file: raw.file };
      if (raw.op === "remove" && "old" in raw && beside(raw.old, raw.file))
        return { op: "remove", file: raw.file, old: raw.old };
      if (
        raw.op === "replace" &&
        "stage" in raw &&
        beside(raw.stage, raw.file) &&
        "old" in raw &&
        "original" in raw &&
        ((raw.old === null && raw.original === null) ||
          (beside(raw.old, raw.file) && identity(raw.original))) &&
        "installed" in raw &&
        identity(raw.installed) &&
        "contents" in raw &&
        typeof raw.contents === "string" &&
        /^[a-f0-9]{64}$/.test(raw.contents)
      )
        return raw as Extract<Entry, { op: "replace" }>;
    }
  }
  throw new Error("invalid installer recovery record");
}

const remove = (file: string) =>
  fs.rmSync(file, { recursive: true, force: true });

// An expected refusal leaves another writer's work in place and names any
// retained backup. I/O failures keep the journal for the next recovery.
function restore(entry: Pending): string | null {
  const { file } = entry;
  switch (entry.op) {
    case "stage":
      remove(file);
      return null;
    case "mkdir":
      if (fileIdentity(file) === null) return null;
      if (fs.readdirSync(file).length > 0)
        return `${file}: kept the directory because it contains files added during installation`;
      fs.rmdirSync(file);
      return null;
    case "remove":
      if (fileIdentity(entry.old) === null) return null;
      if (fileIdentity(file) !== null)
        return `${file}: the path is occupied; its previous contents are kept at ${entry.old}`;
      fs.renameSync(entry.old, file);
      return null;
    case "replace": {
      const current = fileIdentity(file);
      const backup =
        entry.old !== null && fileIdentity(entry.old) !== null
          ? entry.old
          : null;
      // Before publication, or after a previous recovery restored this path.
      if (current !== null && current === entry.original) {
        if (backup !== null) remove(backup);
        return null;
      }
      if (current === null && fileIdentity(entry.stage) !== null) {
        if (backup !== null) fs.renameSync(backup, file);
        return null;
      }
      if (current === null && entry.original === null) return null;
      if (current !== entry.installed || contentsOf(file) !== entry.contents)
        return `${file}: changed after publication; kept the current path${backup === null ? "" : `; previous contents kept at ${backup}`}`;
      if (entry.original !== null && backup === null)
        throw new Error(`missing backup ${entry.old}; kept published file`);
      // Put the new directory back under its own stage name first. If killed
      // here, the missing-destination case above finishes restoring the old.
      fs.renameSync(file, entry.stage);
      if (backup !== null) fs.renameSync(backup, file);
      return null;
    }
  }
}

const JOURNAL = ".cc-candybar-install-v1.jsonl";

export class InstallJournal {
  private readonly entries: Pending[] = [];
  private committed = false;
  private constructor(private readonly file: string | null) {}

  static start(home?: string): InstallJournal {
    const file = home === undefined ? null : path.join(home, JOURNAL);
    const journal = new InstallJournal(file);
    if (file !== null) {
      const existing = fs.lstatSync(file, { throwIfNoEntry: false });
      if (existing !== undefined) {
        if (
          !existing.isFile() ||
          existing.nlink !== 1 ||
          (existing.mode & 0o077) !== 0 ||
          existing.uid !== process.getuid?.()
        )
          throw new Error(`cannot trust installer recovery journal ${file}`);
        const previous = new InstallJournal(file);
        try {
          // An incomplete last append preceded the operation and can be ignored.
          for (const line of readRegularTextSync(file).split("\n").slice(0, -1))
            previous.remember(entryOf(JSON.parse(line)));
        } catch (error) {
          throw new Error(`cannot read ${file}: ${asError(error).message}`, {
            cause: error,
          });
        }
        const kept = previous.settle();
        process.stderr.write(
          `install: recovered interrupted installation${kept.length ? "\n" + kept.join("\n") : ""}\n`,
        );
      }
      fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 });
    }
    return journal;
  }

  private remember(entry: Entry): void {
    if (this.committed)
      throw new Error("installer journal has an entry after commit");
    if (entry.op === "commit") this.committed = true;
    else this.entries.push(entry);
  }

  record(entry: Entry): void {
    if (this.file !== null)
      fs.appendFileSync(this.file, JSON.stringify(entry) + "\n");
    this.remember(entry);
  }

  settle(): string[] {
    const kept: string[] = [];
    const failures: string[] = [];
    const pendingStages = new Set<string>();
    for (const entry of [...this.entries].reverse()) {
      if (entry.op === "stage" && pendingStages.has(entry.file)) continue;
      try {
        if (this.committed) {
          if (entry.op === "stage") remove(entry.file);
          else if ("old" in entry && entry.old !== null) remove(entry.old);
        } else {
          const note = restore(entry);
          if (note !== null) kept.push(note);
        }
      } catch (error) {
        if (entry.op === "replace") pendingStages.add(entry.stage);
        failures.push(`${entry.file}: ${asError(error).message}`);
      }
    }
    if (failures.length > 0)
      throw new Error(
        `install could not finish recovery${this.file === null ? "" : ` (journal retained at ${this.file})`}:\n${[...kept, ...failures].join("\n")}`,
      );
    if (this.file !== null) fs.unlinkSync(this.file);
    return kept;
  }
}
