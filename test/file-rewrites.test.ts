import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeConfigFile, writeRevisions } from "../src/daemon/file-rewrites";

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
  expect(result).toEqual({ kind: "ok", files: [existing, fresh] });
  expect(fs.readFileSync(existing, "utf8")).toBe("after");
  expect(fs.statSync(existing).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(fresh, "utf8")).toBe("new");
  expect(fs.statSync(fresh).mode & 0o777).toBe(0o644);
});

// A state file that did not read is renamed aside before its new bytes are
// written at its name, so no write ever replaces what could not be read.
test("a set-aside lands before the rewrite, and a failed batch puts it back", () => {
  const book = path.join(dir, "book.json");
  const aside = `${book}.unread-x`;
  fs.writeFileSync(book, "{ not json");
  const seen: Array<string | null> = [];
  const refused = new Error("the disk refused");
  const result = writeRevisions(
    {
      setAside: { from: book, to: aside },
      rewrites: [{ file: book, was: null, will: "{}\n" }],
      retire: null,
    },
    (file, text, mode) => {
      seen.push(fs.existsSync(aside) ? fs.readFileSync(aside, "utf8") : null);
      if (text !== null) throw refused;
      writeConfigFile(file, text, mode);
    },
  );
  expect(seen[0]).toBe("{ not json");
  expect(result).toEqual({ kind: "failed", error: refused });
  expect(fs.readFileSync(book, "utf8")).toBe("{ not json");
  expect(fs.existsSync(aside)).toBe(false);

  expect(
    writeRevisions({
      setAside: { from: book, to: aside },
      rewrites: [{ file: book, was: null, will: "{}\n" }],
      retire: null,
    }),
  ).toEqual({ kind: "ok", files: [aside, book] });
  expect(fs.readFileSync(aside, "utf8")).toBe("{ not json");
  expect(fs.readFileSync(book, "utf8")).toBe("{}\n");
});
