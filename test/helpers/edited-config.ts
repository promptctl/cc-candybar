import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A config file that each `edit()` rewrites to load something new, for a test
// that reloads to drive a build: a reload whose inputs are unchanged keeps the
// state it serves. The edit moves a literal variable, which no compile reads,
// so the reloaded state shares the compile of the one it replaces and a
// budget sized in compiles is unmoved.
export interface EditedConfig {
  readonly file: string;
  edit(): void;
  cleanup(): void;
}

export function editedConfig(): EditedConfig {
  const dir = mkdtempSync(join(tmpdir(), "cc-candybar-edited-"));
  const file = join(dir, "config.json5");
  let edition = 0;
  const write = () =>
    writeFileSync(
      file,
      `{ variables: { edition: { kind: "literal", value: "${edition++}" } } }\n`,
    );
  write();
  return {
    file,
    edit: write,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

let projectEdition = 0;

// The same edit for a test whose entry loads the project config in `dir`
// (a directory whose repository the test has answered): each call writes a
// project config that loads something new.
export function editProjectConfig(dir: string): void {
  writeFileSync(
    join(dir, ".cc-candybar.json5"),
    `{ variables: { edition: { kind: "literal", value: "${projectEdition++}" } } }\n`,
  );
}
