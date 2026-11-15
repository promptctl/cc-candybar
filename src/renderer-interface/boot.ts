// What a renderer's process is started with, beside the environment it
// inherits: the generation it mints its ids under, the files it keeps, its
// share of the memory limit, and the bundle the doctor judges clients against.
// [LAW:one-source-of-truth] The host's own values, handed down, so the
// renderer derives no path of its own.

import type { Generation } from "./interface.js";

export interface RendererBoot {
  readonly generation: Generation;
  readonly stateDir: string;
  readonly sessionState: string;
  readonly settingsHistory: string;
  readonly memoryShareBytes: number;
  readonly bundle: string;
}

// [LAW:parse-dont-validate] The one reading of a boot, from its argument: a
// boot that does not read is the host's bug, thrown before anything starts.
export function parseBoot(text: string | undefined): RendererBoot {
  const v: unknown = text === undefined ? undefined : JSON.parse(text);
  if (typeof v !== "object" || v === null)
    throw new Error(`a renderer's boot is a JSON object, got ${String(text)}`);
  const b = v as Record<string, unknown>;
  const strings = ["stateDir", "sessionState", "settingsHistory", "bundle"];
  const numbers = ["generation", "memoryShareBytes"];
  for (const key of strings)
    if (typeof b[key] !== "string")
      throw new Error(`a renderer's boot has no ${key}: ${text}`);
  for (const key of numbers)
    if (!Number.isSafeInteger(b[key]) || (b[key] as number) <= 0)
      throw new Error(`a renderer's boot has no ${key}: ${text}`);
  return {
    generation: b.generation as Generation,
    stateDir: b.stateDir as string,
    sessionState: b.sessionState as string,
    settingsHistory: b.settingsHistory as string,
    memoryShareBytes: b.memoryShareBytes as number,
    bundle: b.bundle as string,
  };
}
