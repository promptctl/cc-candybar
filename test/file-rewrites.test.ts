import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  setAside,
  writeConfigFile,
  writeRevisions,
} from "../src/daemon/file-rewrites";

let dir: string;
let umask: number;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-file-rewrites-"));
  umask = process.umask(0o022);
});
afterEach(() => {
  process.umask(umask);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a failed batch restores the contents and permissions of a removed file", () => {
  const privateFile = path.join(dir, "private.json5");
  const blocked = path.join(dir, "blocked.json5");
  const original = "{ privateSetting: true }\n";
  fs.writeFileSync(privateFile, original, { mode: 0o600 });
  const refused = new Error("the second file could not be published");
  let removed = false;
  const result = writeRevisions(
    {
      setAside: null,
      rewrites: [
        { file: privateFile, was: original, will: null },
        { file: blocked, was: null, will: "{}\n" },
      ],
      retire: null,
    },
    (file, text, mode) => {
      if (file === blocked) {
        removed = !fs.existsSync(privateFile);
        throw refused;
      }
      writeConfigFile(file, text, mode);
    },
  );
  expect(removed).toBe(true);
  expect(result).toEqual({ kind: "failed", error: refused });
  expect(fs.readFileSync(privateFile, "utf8")).toBe(original);
  expect(fs.statSync(privateFile).mode & 0o777).toBe(0o600);
});

test("replacements keep permissions and new files take the umask", () => {
  const existing = path.join(dir, "existing.json5");
  const fresh = path.join(dir, "fresh.json5");
  fs.writeFileSync(existing, "before", { mode: 0o600 });
  const result = writeRevisions({
    setAside: null,
    rewrites: [
      { file: existing, was: "before", will: "after" },
      { file: fresh, was: null, will: "new" },
    ],
    retire: null,
  });
  expect(result).toEqual({
    kind: "ok",
    files: [existing, fresh],
    setAside: null,
  });
  expect(fs.readFileSync(existing, "utf8")).toBe("after");
  expect(fs.statSync(existing).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(fresh, "utf8")).toBe("new");
  expect(fs.statSync(fresh).mode & 0o777).toBe(0o644);
});

// A state file that did not read is set aside before its new bytes are
// written at its name, so no write ever replaces what could not be read.
test("a set-aside lands before the rewrite, and a failed batch puts it back", () => {
  const book = path.join(dir, "book.json");
  const unread = () =>
    fs.readdirSync(dir).filter((name) => name.startsWith("book.json.unread-"));
  fs.writeFileSync(book, "{ not json");
  const unreadBook = {
    kind: "failed",
    reason: `${book} is not JSON`,
    file: book,
  } as const;
  const seen: string[][] = [];
  const refused = new Error("the disk refused");
  const result = writeRevisions(
    {
      setAside: unreadBook,
      rewrites: [{ file: book, was: null, will: "{}\n" }],
      retire: null,
    },
    (file, text, mode) => {
      seen.push(unread());
      if (text !== null) throw refused;
      writeConfigFile(file, text, mode);
    },
  );
  expect(seen[0]).toHaveLength(1);
  expect(result).toEqual({ kind: "failed", error: refused });
  expect(fs.readFileSync(book, "utf8")).toBe("{ not json");
  expect(unread()).toEqual([]);

  const landed = writeRevisions({
    setAside: unreadBook,
    rewrites: [{ file: book, was: null, will: "{}\n" }],
    retire: null,
  });
  const aside = path.join(dir, unread()[0]!);
  expect(landed).toEqual({
    kind: "ok",
    files: [aside, book],
    setAside: {
      file: book,
      reason: `${book} is not JSON`,
      from: book,
      to: aside,
    },
  });
  expect(fs.readFileSync(aside, "utf8")).toBe("{ not json");
  expect(fs.readFileSync(book, "utf8")).toBe("{}\n");
});

// [LAW:no-silent-failure] The one rollback that leaves the bytes aside says
// where they are.
test("a set-aside that cannot be put back names the copy its bytes are in", () => {
  const book = path.join(dir, "book.json");
  fs.writeFileSync(book, "{ not json");
  const refused = new Error("the disk refused");
  const result = writeRevisions(
    {
      setAside: { kind: "failed", reason: `${book} is not JSON`, file: book },
      rewrites: [{ file: book, was: null, will: "{}\n" }],
      retire: null,
    },
    () => {
      // A directory with an entry now stands at the book's name, so the
      // rename back fails.
      fs.mkdirSync(path.join(book, "entry"), { recursive: true });
      throw refused;
    },
  );
  const [aside] = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("book.json.unread-"));
  const kept = path.join(dir, aside!);
  expect(fs.readFileSync(kept, "utf8")).toBe("{ not json");
  expect(result).toMatchObject({
    kind: "incomplete",
    error: refused,
    unrestored: [{ file: book }],
  });
  if (result.kind !== "incomplete") throw new Error("the rollback put it back");
  expect(result.unrestored[0].error.message).toContain(
    `its bytes are kept at ${kept}`,
  );
});

// [LAW:single-enforcer] A link is written where it points, so the bytes a
// set-aside keeps are its target's, and the link stays a link.
test("a set-aside of a link moves its target and leaves the link", () => {
  const target = path.join(dir, "real.json");
  const link = path.join(dir, "book.json");
  fs.writeFileSync(target, "{ not json");
  fs.symlinkSync(target, link);
  const { from, to } = setAside(link);
  expect(from).toBe(target);
  expect(to.startsWith(`${target}.unread-`)).toBe(true);
  expect(fs.readFileSync(to, "utf8")).toBe("{ not json");
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.existsSync(target)).toBe(false);
});
