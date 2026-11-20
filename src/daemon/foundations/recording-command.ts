import { isAbsolute } from "node:path";
import { isPlainObject } from "../../config/loader/validate-core.js";
import { rendererNameOf, type RendererName } from "./renderer-name.js";
import { BadVerbArgs } from "./verb-error.js";

export type RecordingCommand =
  | {
      readonly action: "start";
      readonly renderer: RendererName;
      readonly file: string;
    }
  | { readonly action: "stop"; readonly renderer: RendererName };

// [LAW:parse-dont-validate] The daemon runs outside the invoking CLI's cwd.
// Only the caller can resolve its chosen filename.
export function recordingCommandOf(value: unknown): RecordingCommand {
  if (!isPlainObject(value) || typeof value.renderer !== "string")
    throw new BadVerbArgs("recording needs a renderer name");
  let name: RendererName;
  try {
    name = rendererNameOf(value.renderer);
  } catch (error) {
    throw new BadVerbArgs(String(error));
  }
  if (value.action === "stop") return { action: "stop", renderer: name };
  if (
    value.action === "start" &&
    typeof value.file === "string" &&
    isAbsolute(value.file) &&
    !value.file.includes("\0")
  )
    return { action: "start", renderer: name, file: value.file };
  throw new BadVerbArgs(
    "recording needs stop, or start with an absolute output file",
  );
}
