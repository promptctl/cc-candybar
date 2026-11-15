// What a renderer's process is started with, beside the environment it
// inherits: the generation it mints its ids under, the files it keeps, the
// memory limit its backstop judges it by, the bundle the doctor judges clients
// against, and the build the host runs.
// [LAW:one-source-of-truth] The host's own values, handed down, so the
// renderer derives no path of its own.

import type { Generation } from "./interface.js";

export interface RendererBoot {
  readonly generation: Generation;
  readonly stateDir: string;
  readonly sessionState: string;
  readonly settingsHistory: string;
  readonly memoryLimitBytes: number;
  readonly bundle: string;
  // The digest of the source the host's bundle was built from, `null` for one
  // that carries none: a renderer is the host's own build, or it refuses.
  readonly digest: string | null;
}

// [LAW:parse-dont-validate] The one reading of a boot, from its argument: a
// boot that does not read is the host's bug, thrown before anything starts.
export function parseBoot(text: string | undefined): RendererBoot {
  const v: unknown = text === undefined ? undefined : JSON.parse(text);
  if (typeof v !== "object" || v === null)
    throw new Error(`a renderer's boot is a JSON object, got ${String(text)}`);
  const b = v as Record<string, unknown>;
  const strings = ["stateDir", "sessionState", "settingsHistory", "bundle"];
  const numbers = ["generation", "memoryLimitBytes"];
  for (const key of strings)
    if (typeof b[key] !== "string")
      throw new Error(`a renderer's boot has no ${key}: ${text}`);
  for (const key of numbers)
    if (!Number.isSafeInteger(b[key]) || (b[key] as number) <= 0)
      throw new Error(`a renderer's boot has no ${key}: ${text}`);
  if (typeof b.digest !== "string" && b.digest !== null)
    throw new Error(`a renderer's boot has no digest: ${text}`);
  return {
    generation: b.generation as Generation,
    stateDir: b.stateDir as string,
    sessionState: b.sessionState as string,
    settingsHistory: b.settingsHistory as string,
    memoryLimitBytes: b.memoryLimitBytes as number,
    bundle: b.bundle as string,
    digest: b.digest,
  };
}

// [LAW:single-enforcer] The one check that a renderer is the host's build:
// the wire's payloads are cast on the premise that both ends are one bundle,
// so a renderer started from a bundle replaced on disk since the host loaded
// it refuses before it answers anything.
export function sameBuild(boot: RendererBoot, own: string | null): void {
  if (boot.digest !== own)
    throw new Error(
      `the renderer's build (${own ?? "no digest"}) is not its host's (${boot.digest ?? "no digest"}): the bundle changed on disk since the host started`,
    );
}
