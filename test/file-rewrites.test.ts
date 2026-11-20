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
    [
      { file: privateFile, was: original, will: null },
      { file: blocked, was: null, will: "{}\n" },
    ],
    null,
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
  const result = writeRevisions(
    [
      { file: existing, was: "before", will: "after" },
      { file: fresh, was: null, will: "new" },
    ],
    null,
  );
  expect(result).toEqual({ kind: "ok", files: [existing, fresh] });
  expect(fs.readFileSync(existing, "utf8")).toBe("after");
  expect(fs.statSync(existing).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(fresh, "utf8")).toBe("new");
  expect(fs.statSync(fresh).mode & 0o777).toBe(0o644);
});
