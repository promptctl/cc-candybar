import type { ConfigTarget, RenderOrigin } from "../../config-hint";

// [LAW:parse-dont-validate] What a record's two fields say together. The path
// is what a session reads and keeps its meaning across builds, so no path is a
// search whichever build wrote it. The source also carries explicit isolation. A source this
// build cannot read, because a newer build has a source of its own, leaves the
// path standing with its source unknown. A refusal here would fail every
// durable click over a label.
function recordedTarget(
  source: unknown,
  configFile: string | null,
): ConfigTarget {
  if (configFile === null) return { source: "search" };
  return source === "argument" ||
    source === "argument-only" ||
    source === "environment"
    ? { source, path: configFile }
    : { source: "unknown", path: configFile };
}

// An origin as a file keeps it: flat, its target's path and source apart.
export function originRecord({ projectDir, cwd, target }: RenderOrigin) {
  return {
    projectDir,
    cwd,
    configFile: target.path ?? null,
    source: target.source,
  };
}

// [LAW:parse-dont-validate] The one boundary that lifts a kept record back
// into a RenderOrigin: null for one of the wrong shape, never a guessed path.
export function originOfRecord(value: unknown): RenderOrigin | null {
  if (value === null || typeof value !== "object") return null;
  const { projectDir, cwd, configFile, source } = value as Record<
    string,
    unknown
  >;
  if (
    typeof projectDir !== "string" ||
    typeof cwd !== "string" ||
    (configFile !== null && typeof configFile !== "string")
  )
    return null;
  return { projectDir, cwd, target: recordedTarget(source, configFile) };
}
