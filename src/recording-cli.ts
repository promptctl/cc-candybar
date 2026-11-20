import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Buffer } from "node:buffer";
import type { CliPlan } from "./cli-plan.js";
import {
  describeFailure,
  requestOutcome,
  type ClientWorld,
  type RoundTripBudgets,
} from "./daemon/client-transport.js";
import {
  MAIN_RENDERER,
  rendererNameOf,
} from "./daemon/foundations/renderer-name.js";
import type { RecordingCommand } from "./daemon/foundations/recording-command.js";
import type { WireFrame } from "./render/frame.js";
import type {
  EventInput,
  RendererOutput,
} from "./renderer-interface/interface.js";
import { readRegularTextLines } from "./utils/regular-text.js";

const RECORD_USAGE =
  "Usage: cc-candybar record start <file> [--renderer NAME]\n" +
  "       cc-candybar record stop [--renderer NAME]";
const REPLAY_USAGE = "Usage: cc-candybar replay <file> [--frames]";
const FRAME_EXPORT_MIB = 32;
const FRAME_EXPORT_BYTES = FRAME_EXPORT_MIB * 1024 * 1024;

// Recording can queue behind a turn, replace a process, or publish a file.
const RECORD_BUDGETS: RoundTripBudgets = { connectMs: 200, budgetMs: 5_000 };

const failed = (
  command: "record" | "replay",
  reason: string,
  code: number,
): CliPlan => ({
  stdout: "",
  stderr: `cc-candybar ${command}: ${reason}\n`,
  code,
});
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function recordCommand(
  args: readonly string[],
  cwd: string,
  defaultRenderer: string,
): RecordingCommand {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { renderer: { type: "string" } },
    allowPositionals: true,
  });
  const [action, file, ...extra] = positionals;
  const renderer = rendererNameOf(values.renderer ?? defaultRenderer);
  if (action === "stop" && file === undefined) return { action, renderer };
  if (
    action === "start" &&
    file !== undefined &&
    file !== "" &&
    extra.length === 0
  )
    return { action, renderer, file: resolve(cwd, file) };
  throw new Error("expected `start <file>` or `stop`");
}

// [LAW:effects-at-boundaries] This operator command asks the running owner
// of the work. No failure of this request can start a daemon.
export async function recordPlan(
  world: ClientWorld,
  cwd: string,
  args: readonly string[],
): Promise<CliPlan> {
  let command: RecordingCommand;
  try {
    command = recordCommand(
      args,
      cwd,
      world.host.env.CC_CANDYBAR_NAME ?? MAIN_RENDERER,
    );
  } catch (error) {
    return failed("record", `${messageOf(error)}\n${RECORD_USAGE}`, 2);
  }
  const outcome = await requestOutcome(
    world,
    () => ({ kind: "recording", command }),
    RECORD_BUDGETS,
    (response) =>
      "output" in response && typeof response.output === "string"
        ? response.output
        : undefined,
  );
  if (outcome.kind !== "ok")
    return failed("record", describeFailure(outcome), 1);
  const stdout = outcome.value.endsWith("\n")
    ? outcome.value
    : `${outcome.value}\n`;
  return { stdout, stderr: "", code: 0 };
}

type ReplayTurn = (input: EventInput, output: RendererOutput) => void;
type Replay = (
  lines: AsyncIterable<string>,
  onTurn?: ReplayTurn,
) => Promise<{ turns: number }>;

function replayArgs(args: readonly string[]): {
  file: string;
  frames: boolean;
} {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { frames: { type: "boolean", default: false } },
    allowPositionals: true,
  });
  const [file] = positionals;
  if (file === undefined || file === "" || positionals.length !== 1)
    throw new Error("expected one recording file");
  return { file, frames: values.frames };
}

function collectFrames(lines: string[]): ReplayTurn {
  let bytes = 0;
  const emit = (
    session: string,
    surface: "statusline" | "pane",
    frame: WireFrame,
  ): void => {
    const line = JSON.stringify({ session, surface, frame }) + "\n";
    bytes += Buffer.byteLength(line);
    // [LAW:carrying-cost] Frame export holds output until verification.
    // Keep the optional buffer bounded. Summary mode allocates no buffer.
    if (bytes > FRAME_EXPORT_BYTES)
      throw new Error(
        `frame output exceeds ${FRAME_EXPORT_MIB} MiB. Replay without --frames to verify the recording.`,
      );
    lines.push(line);
  };
  return (_input, output) => {
    for (const effect of output.effects) {
      if (effect.kind === "present")
        emit(effect.session, effect.surface, effect.frame);
    }
    for (const { session, frame } of output.frames) {
      if (frame.kind !== "drawn") continue;
      emit(session, "pane", frame.bar);
      if (frame.handoff !== null) emit(session, "statusline", frame.handoff);
    }
  };
}

export async function replayPlan(
  args: readonly string[],
  replay: Replay,
): Promise<CliPlan> {
  let chosen: ReturnType<typeof replayArgs>;
  try {
    chosen = replayArgs(args);
  } catch (error) {
    return failed("replay", `${messageOf(error)}\n${REPLAY_USAGE}`, 2);
  }
  // [LAW:no-silent-failure] An accepted prefix is insufficient. Even in
  // frame mode nothing goes to stdout until the terminal entry is verified.
  const frames: string[] | null = chosen.frames ? [] : null;
  try {
    const { turns } = await replay(
      readRegularTextLines(chosen.file),
      frames === null ? undefined : collectFrames(frames),
    );
    const summary = `Verified ${turns} renderer ${turns === 1 ? "turn" : "turns"}.\n`;
    return frames === null
      ? { stdout: summary, stderr: "", code: 0 }
      : { stdout: frames.join(""), stderr: summary, code: 0 };
  } catch (error) {
    return failed("replay", messageOf(error), 1);
  }
}
