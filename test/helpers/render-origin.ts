import type { RenderOrigin } from "../../src/config-hint";

// The origin of a session in `dir`: its config named on the command line when
// `file` is given, else the search.
export function originAt(dir: string, file?: string): RenderOrigin {
  return {
    projectDir: dir,
    cwd: dir,
    target:
      file === undefined
        ? { source: "search" }
        : { source: "argument", path: file },
  };
}
